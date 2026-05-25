/**
 * Post-handoff turns — thanks / ack without restarting maintenance gather.
 */
const { hasProblemSignal } = require("../../brain/core/splitIssueGroups");

const ACK_TOKEN =
  /^(ok|okay|k|kk|thanks|thank|you|ty|thx|so|much|again|awesome|great|perfect|cool|nice|wonderful|np|nope|cheers|appreciate|it|that|got|sound|sounds|good|welcome|the|best)$/i;

const DEFAULT_ACK = "You're welcome!";

const NO_FURTHER_HELP_RE =
  /\b(i'?m|im)\s+(good|fine|all set|done|sorted|okay|ok)\b|\b(no\s+(service|help|maintenance)\s+(needed|required|necessary)|don'?t need (any )?(help|service|maintenance)|nothing (else|more)?|all good|that'?s all|that is all|no service schedule)\b/i;

/**
 * Tenant is done — not starting a new maintenance request.
 * @param {string} text
 * @returns {boolean}
 */
function isNoFurtherHelpNeeded(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.length > 160) return false;
  if (NO_FURTHER_HELP_RE.test(raw)) return true;
  if (hasProblemSignal(raw)) return false;
  if (/\b(also|another|new issue|something else|other problem|as well|broken|leak|fix)\b/i.test(raw)) {
    return false;
  }
  return false;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isConfusionOnly(text) {
  const raw = String(text || "").trim();
  return /^[?？!.\s]{1,8}$/.test(raw);
}

const CONFUSED_TENANT_RE =
  /^(?:what\s*(?:do\s*)?you\s*mean|what\s*mean|what\s*is\s*that|what\s*is\s*this|huh|what\??|sorry\s*what|i\s*don'?t\s*understand|confused|wait\s*what|what\s*are\s*you\s*(?:talking\s*about|asking)|what\s*does\s*that\s*mean)[!?.\s]*$/i;

/**
 * Tenant is lost — not reporting maintenance.
 * @param {string} text
 * @returns {boolean}
 */
function isTenantConfusedMessage(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.length > 120) return false;
  if (hasProblemSignal(raw)) return false;
  return isConfusionOnly(raw) || CONFUSED_TENANT_RE.test(raw);
}

/**
 * @returns {string}
 */
function buildConfusionResetReply() {
  return (
    "Sorry if that was unclear — I'm the maintenance line. " +
    "If something needs repair, tell me your building, unit, and what's going wrong."
  );
}

/**
 * @returns {string}
 */
function postClosedSoftReply() {
  return (
    "I'm set up for maintenance requests only. " +
    "If something needs repair, tell me your building, unit, and what's wrong."
  );
}

/**
 * @returns {string}
 */
function postNoFurtherHelpReply() {
  return "Sounds good — message us anytime you have a maintenance issue.";
}

/**
 * Closing / done / confusion — do not merge into maintenance slots.
 * @param {string} text
 * @returns {boolean}
 */
function shouldSkipInboundSlotMerge(text) {
  const bodyText = String(text || "").trim();
  if (!bodyText) return false;
  return (
    isPostHandoffChitchat(bodyText) ||
    isNoFurtherHelpNeeded(bodyText) ||
    isConfusionOnly(bodyText) ||
    isTenantConfusedMessage(bodyText)
  );
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isPostHandoffChitchat(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.length > 120) return false;
  if (hasProblemSignal(raw)) return false;
  if (/\b(also|another|new issue|something else|other problem|as well)\b/i.test(raw)) {
    return false;
  }
  if (/^[👍🙏]+$/.test(raw)) return true;

  const tokens = raw
    .replace(/[^\w\s👍🙏]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (!tokens.length || tokens.length > 10) return false;
  return tokens.every((t) => ACK_TOKEN.test(t) || /^[👍🙏]+$/.test(t));
}

/**
 * @param {string} [text]
 * @returns {string}
 */
function postHandoffAckReply(_text) {
  return DEFAULT_ACK;
}

module.exports = {
  isPostHandoffChitchat,
  isNoFurtherHelpNeeded,
  isConfusionOnly,
  isTenantConfusedMessage,
  buildConfusionResetReply,
  postHandoffAckReply,
  postClosedSoftReply,
  postNoFurtherHelpReply,
  shouldSkipInboundSlotMerge,
  DEFAULT_ACK,
};
