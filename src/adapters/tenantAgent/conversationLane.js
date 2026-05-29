/**
 * Conversation lane — thin facade over the typed conversation state.
 *
 * The lane itself is owned by `conversationState.js` (Piece 3). This file
 * keeps the legacy export names so existing callers don't churn, plus the
 * inference / signal-detection helpers that are lane-specific behavior
 * rather than raw state mutation.
 */
const { isMaintenanceRepairRequest } = require("./classifyNonMaintenanceRequest");
const { hasRecentAccessBooking } = require("./accessConversationSignals");
const { isPostHandoffChitchat } = require("./postHandoffReply");
const {
  CONVERSATION_LANE,
  readActiveLane,
  withActiveLane,
  withoutActiveLane,
  readAccessRequest,
  readAccessLastBooking,
  readAccessLastError,
} = require("./conversationState");

const LANE_FRIENDLY_TAIL =
  "(?:\\s+(?:(?:my\\s+)?(?:there|brother|bro|man|dude|mate|friend|buddy|fam|papa|mama|ma|dad|sir)))*";

const LANE_CLOSE_RE = new RegExp(
  "^(?:ok\\.?\\s*|okay\\.?\\s*)?" +
    "(?:thanks?(?: you)?(?: so much)?|thank you|thx|ty|cool|great|perfect|got it|sounds good|cheers|all set|all done|that'?s all|that is all|never\\s*mind|nevermind|bye|goodbye|done|ok thanks?|good thanks?)" +
    `${LANE_FRIENDLY_TAIL}[.!?]?\\s*$`,
  "i"
);

/**
 * @param {object | null | undefined} partial
 * @returns {string}
 */
function getConversationLane(partial) {
  return readActiveLane(partial);
}

/**
 * @param {object} partial
 * @param {string} lane
 * @returns {object}
 */
function withConversationLane(partial, lane) {
  return withActiveLane(partial, lane);
}

/**
 * Infer lane from partial when `_active_lane` was not set (older rows).
 *
 * This is the ONLY place where lane is inferred from working-memory tells —
 * once the resolver sets `_active_lane` (Piece 3), every subsequent turn
 * reads the explicit field. Inference only fires on legacy rows or the
 * very first turn before the resolver has stamped anything.
 *
 * @param {object | null} conv
 */
function inferConversationLane(conv) {
  const partial = conv?.partial_package || {};
  const explicit = readActiveLane(partial);
  if (explicit) return explicit;

  if (
    readAccessRequest(partial) ||
    readAccessLastBooking(partial) ||
    readAccessLastError(partial) ||
    String(conv?.last_brain_result?.brain || "").startsWith("access_")
  ) {
    return CONVERSATION_LANE.ACCESS;
  }

  if (String(partial.issue || "").trim().length >= 2) {
    return CONVERSATION_LANE.MAINTENANCE;
  }

  return "";
}

/**
 * Soft "is this an access-themed thread?" check — kept for legacy callers.
 * The sticky-lane router (`resolveActiveLane`) is the new source of truth.
 *
 * @param {object | null} conv
 * @param {string} bodyText
 */
function shouldStayInAccessLane(conv, bodyText) {
  if (isMaintenanceRepairRequest(bodyText)) return false;

  const partial = conv?.partial_package || {};
  const lane = readActiveLane(partial) || inferConversationLane(conv);

  if (lane === CONVERSATION_LANE.ACCESS) return true;
  if (hasRecentAccessBooking(conv)) return true;
  if (readAccessRequest(partial)) return true;

  return false;
}

/**
 * Sticky lane decision — one resolution per turn, no per-turn re-detection.
 * @param {object | null} conv
 * @returns {string}
 */
function resolveActiveLane(conv) {
  const partial = conv?.partial_package || {};
  const explicit = readActiveLane(partial);
  if (explicit) return explicit;
  return inferConversationLane(conv);
}

/**
 * Clear lane so the next message gets re-decided fresh.
 * @param {object} partial
 */
function clearConversationLane(partial) {
  return withoutActiveLane(partial);
}

/**
 * Cross-lane interrupt — a clear maintenance repair signal inside an access lane.
 * The lane does not abandon; we acknowledge and stay.
 * @param {string} bodyText
 */
function isStrongMaintenanceInterrupt(bodyText) {
  return isMaintenanceRepairRequest(bodyText);
}

/**
 * Tenant says they're done — "thanks", "all set", "never mind".
 * Used to close the lane explicitly so the next message gets re-detected.
 * @param {string} bodyText
 */
function isLaneCloseSignal(bodyText) {
  const t = String(bodyText || "").trim();
  if (!t || t.length > 80) return false;
  return LANE_CLOSE_RE.test(t);
}

/**
 * After access_reserved, tenant thanks / ack — close lane; do not re-reserve the
 * same window (overlap with their own booking).
 *
 * @param {object | null} conv
 * @param {string} bodyText
 */
function shouldCloseAccessLaneAfterBooking(conv, bodyText) {
  if (!hasRecentAccessBooking(conv)) return false;
  return isAccessLaneAckOnly(bodyText);
}

/**
 * Tenant is done with access — no new time window in this message.
 * @param {string} bodyText
 * @returns {boolean}
 */
function isAccessLaneAckOnly(bodyText) {
  const text = String(bodyText || "").trim();
  if (!text || text.length > 80) return false;
  const { bodyHasAccessTimeIntent } = require("./accessConversationSignals");
  if (bodyHasAccessTimeIntent(text)) return false;
  if (/\b(book|reserve|cancel|change|move|different time|another time|list)\b/i.test(text)) {
    return false;
  }
  if (/\b(also|another|new)\b/i.test(text) && /\b(issue|leak|broken|maintenance)\b/i.test(text)) {
    return false;
  }
  return isLaneCloseSignal(text) || isPostHandoffChitchat(text);
}

module.exports = {
  CONVERSATION_LANE,
  getConversationLane,
  withConversationLane,
  clearConversationLane,
  inferConversationLane,
  resolveActiveLane,
  shouldStayInAccessLane,
  isStrongMaintenanceInterrupt,
  isLaneCloseSignal,
  shouldCloseAccessLaneAfterBooking,
  isAccessLaneAckOnly,
};
