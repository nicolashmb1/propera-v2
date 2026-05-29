/**
 * Access gather — conversation context (not keyword-only intent).
 */
const { ACCESS_INTENT_TYPES } = require("../../access/parseAccessIntent");

const AVAILABILITY_RE =
  /\b(available|availability|what times?|what time|when can i|open slots?|free times?|what'?s open|other times?|anything open|operating hours?|hours of operation|from what time|to what time|what hours?|when (is|does).+open|when (is|does).+close)\b/i;

/**
 * @param {string} bodyText
 */
function isAvailabilityQuestion(bodyText) {
  return AVAILABILITY_RE.test(String(bodyText || "").trim());
}

/**
 * @param {object[]} messages
 * @returns {string}
 */
function lastAssistantMessage(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i]?.role === "assistant") {
      return String(arr[i].content || "").trim();
    }
  }
  return "";
}

/**
 * @param {string} lastAssistant
 */
function assistantOfferedAvailabilityCheck(lastAssistant) {
  const t = String(lastAssistant || "").trim();
  if (!t) return false;
  return /\b(other|available|availability|check for|what times|open times|different time|anything else)\b/i.test(
    t
  );
}

/**
 * @param {string} lastAssistant
 */
function assistantAskedBookingConfirm(lastAssistant) {
  const t = String(lastAssistant || "").trim();
  if (!t) return false;
  return /\b(confirm|is that (right|correct)|should i book|go ahead and book|reserve that|book that|want me to book)\b/i.test(
    t
  );
}

/**
 * @param {string} bodyText
 */
function isAffirmativeConfirmation(bodyText) {
  const t = String(bodyText || "").trim();
  if (!t || t.length > 40) return false;
  return /^(yes|yeah|yep|yup|correct|right|that'?s right|sounds good|perfect|ok|okay|sure|confirm|confirmed)\.?$/i.test(
    t
  );
}

/**
 * "yes" only confirms a reserve handoff when the assistant asked to confirm a booking.
 * @param {string} bodyText
 * @param {object[]} messages
 */
function shouldConfirmReserveHandoff(bodyText, messages) {
  if (!isAffirmativeConfirmation(bodyText)) return false;
  const last = lastAssistantMessage(messages);
  if (assistantOfferedAvailabilityCheck(last)) return false;
  return assistantAskedBookingConfirm(last);
}

/**
 * "yes" / "sure" after "want to check other times?" → list calendar, not re-book failed slot.
 * @param {string} bodyText
 * @param {object[]} messages
 */
function affirmativeMeansListSlots(bodyText, messages) {
  if (!isAffirmativeConfirmation(bodyText)) return false;
  return assistantOfferedAvailabilityCheck(lastAssistantMessage(messages));
}

/**
 * Switch partial to list_slots for a day (drops stale reserve window).
 * @param {object} partial
 * @param {string} bodyText
 */
function applyListSlotsIntent(partial, bodyText) {
  const next = { ...(partial || {}) };
  next.intentType = ACCESS_INTENT_TYPES.LIST_SLOTS;
  delete next.startAt;
  delete next.endAt;
  if (!next.dateForDay) {
    if (/\btoday\b/i.test(bodyText)) next.dateForDay = "today";
    else if (/\btomorrow\b/i.test(bodyText)) next.dateForDay = "tomorrow";
    else next.dateForDay = "today";
  }
  return next;
}

const WEEKDAY_NAMES =
  "sunday|monday|tuesday|wednesday|thursday|friday|saturday";
const WEEKDAY_RE = new RegExp(`\\b(${WEEKDAY_NAMES})\\b`, "i");
const WEEKDAY_NOT_RE = new RegExp(
  `\\b(${WEEKDAY_NAMES})\\s+not\\s+(${WEEKDAY_NAMES})\\b`,
  "i"
);

/**
 * @param {object | null} conv
 */
function hasRecentAccessBooking(conv) {
  const { readAccessLastBooking } = require("./conversationState");
  const booking = readAccessLastBooking(conv?.partial_package);
  const lastBrain = conv?.last_brain_result || {};
  return (
    !!booking ||
    String(lastBrain.brain || "").trim() === "access_reserved" ||
    /\bbooked\b/i.test(String(lastBrain.replyText || ""))
  );
}

/**
 * Calendar day hint for package (today, tomorrow, or weekday name).
 * @param {string} bodyText
 */
function extractDateForDayFromText(bodyText) {
  const lower = String(bodyText || "").trim().toLowerCase();
  if (!lower) return "";
  if (/\btoday\b/.test(lower)) return "today";
  if (/\btomorrow\b/.test(lower)) return "tomorrow";

  const neg = lower.match(WEEKDAY_NOT_RE);
  if (neg) return neg[1];

  const beDay = lower.match(
    new RegExp(`\\b(?:be|on|for|to)\\s+(?:this\\s+)?(${WEEKDAY_NAMES})\\b`, "i")
  );
  if (beDay) return beDay[1];

  const thisDay = lower.match(new RegExp(`\\bthis\\s+(${WEEKDAY_NAMES})\\b`, "i"));
  if (thisDay) return thisDay[1];

  const anyDay = lower.match(WEEKDAY_RE);
  if (anyDay) return anyDay[1];

  return "";
}

/**
 * Tenant corrects a booking right after access_reserved (time and/or day).
 * @param {string} bodyText
 * @param {object | null} conv
 */
function isAccessBookingCorrection(bodyText, conv) {
  const text = String(bodyText || "").trim();
  if (!text || !hasRecentAccessBooking(conv)) return false;

  if (
    /\b(wrong|not right|incorrect|i said|meant|should be|not what|that'?s not|my bad|sorry|mistake)\b/i.test(
      text
    )
  ) {
    return true;
  }

  if (/\b(change|changed|move|switch|reschedule)\b.*\b(to|from|day|date|time)\b/i.test(text)) {
    return true;
  }

  if (WEEKDAY_NOT_RE.test(text)) return true;

  if (WEEKDAY_RE.test(text) && /\bnot\b/i.test(text)) return true;

  if (/\bparty\b/i.test(text) && WEEKDAY_RE.test(text)) return true;

  if (/\b(\d{1,2})\b/.test(text) && /\b(\d{1,2})\b.*\b(\d{1,2})\b/.test(text)) return true;

  if (/\b(am|pm)\b/i.test(text)) return true;

  return false;
}

const { bodyHasTimeWindowShape } = require("./scheduleFollowUpShape");
const { parseAccessWindow } = require("../../access/parseAccessIntent");
const { propertyTimezone } = require("../../access/accessLocalTime");

/**
 * Inbound carries a new clock window (not just thanks / ack).
 * @param {string} bodyText
 * @returns {boolean}
 */
function bodyHasAccessTimeIntent(bodyText) {
  const t = String(bodyText || "").trim();
  if (!t) return false;
  if (bodyHasTimeWindowShape(t)) return true;
  if (/\b(am|pm|noon|midnight)\b/i.test(t)) return true;
  const window = parseAccessWindow(t, new Date(), propertyTimezone());
  return !!(window && window.startAt && window.endAt);
}

module.exports = {
  isAvailabilityQuestion,
  lastAssistantMessage,
  assistantOfferedAvailabilityCheck,
  assistantAskedBookingConfirm,
  isAffirmativeConfirmation,
  shouldConfirmReserveHandoff,
  affirmativeMeansListSlots,
  applyListSlotsIntent,
  hasRecentAccessBooking,
  extractDateForDayFromText,
  isAccessBookingCorrection,
  bodyHasAccessTimeIntent,
};
