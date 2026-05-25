/**
 * Post-complete follow-up intent — clarification before brain (Phase 4).
 */
const { hasProblemSignal } = require("../../brain/core/splitIssueGroups");
const { intakeExplicitNewTicketMarkers } = require("../../brain/core/intakeAttachClassify");
const { isPostHandoffChitchat } = require("./postHandoffReply");

/**
 * Tenant is withdrawing / dismissing — not starting a new request.
 * Covers: "forget about it", "never mind", "nvm", "don't bother", "cancel that", etc.
 * @param {string} text
 * @returns {boolean}
 */
const DISMISSAL_RE =
  /^(?:forget(?:\s+about)?(?:\s+it)?|never[\s-]*mind|n(?:vm|m)\b|don'?t\s+(?:bother|worry(?:\s+about\s+it)?)|no\s+(?:worries|need|bother)|leave\s+(?:it|that)|drop\s+it|cancel(?:\s+that)?|disregard(?:\s+that)?|ignore\s+(?:it|that)|scrap\s+(?:it|that)|it'?s?\s+(?:fine|ok(?:ay)?|good)|all\s+(?:good|fine|set)|nah|nope|ok(?:ay)?\s+(?:forget|never\s*mind|nvm|nm)\b|nvm\s+it|nm\s+it)\s*[.!?]*$/i;

function isDismissalIntent(text) {
  return DISMISSAL_RE.test(String(text || "").trim());
}

/** @typedef {'ack_only' | 'explicit_new_intake' | 'ask_same_or_new'} PostCompleteFollowUpClass */

/**
 * @param {object} o
 * @param {string} o.bodyText
 * @param {unknown[]} [o.mediaItems]
 * @returns {PostCompleteFollowUpClass}
 */
function classifyPostCompleteFollowUp(o) {
  const bodyText = String(o.bodyText || "").trim();
  const mediaItems = Array.isArray(o.mediaItems) ? o.mediaItems : [];
  const hasMedia = mediaItems.length > 0;

  if (!bodyText && !hasMedia) {
    return "ask_same_or_new";
  }

  if (bodyText && isPostHandoffChitchat(bodyText)) {
    return "ack_only";
  }

  if (bodyText && isDismissalIntent(bodyText)) {
    return "ack_only";
  }

  if (bodyText && intakeExplicitNewTicketMarkers(bodyText)) {
    return "explicit_new_intake";
  }

  if (/\b(new issue|different problem|separate issue|another issue)\b/i.test(bodyText)) {
    return "explicit_new_intake";
  }

  if (/\b(also|as well)\b/i.test(bodyText) && hasProblemSignal(bodyText)) {
    return "ask_same_or_new";
  }

  if (!bodyText && hasMedia) {
    return "ask_same_or_new";
  }

  if (bodyText && hasProblemSignal(bodyText)) {
    return "ask_same_or_new";
  }

  if (hasMedia) {
    return "ask_same_or_new";
  }

  return "ask_same_or_new";
}

module.exports = {
  classifyPostCompleteFollowUp,
  isDismissalIntent,
};
