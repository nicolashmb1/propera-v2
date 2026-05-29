/**
 * Fallback gather replies when access LLM is off or returns unusable text.
 */
const { ACCESS_INTENT_TYPES } = require("../../access/parseAccessIntent");
const {
  narrateAccessBrainResult,
  explainReasonCode,
} = require("../../access/accessBrainResult");
const { accessLocationDisplayName } = require("./accessGatherRules");

/**
 * @param {object} o
 * @param {string} o.intentType
 * @param {object} o.partial
 * @param {object[]} o.locations
 * @param {object | null} [o.lastAccessError]
 */
function buildAccessDeterministicReply(o) {
  const intent = String(o.intentType || "").trim();
  const partial = o.partial || {};
  const locName = accessLocationDisplayName(partial, o.locations || []);
  const lastErr = o.lastAccessError || null;

  if (intent === "ACCESS_CLARIFY" && lastErr) {
    if (lastErr.accessFacts) {
      const fromFacts = narrateAccessBrainResult(lastErr.accessFacts);
      if (fromFacts) return fromFacts;
    }
    if (lastErr.replyText) return String(lastErr.replyText).trim();
    if (lastErr.code) return explainReasonCode(lastErr.code, locName);
  }

  if (lastErr?.accessFacts) {
    const fromFacts = narrateAccessBrainResult(lastErr.accessFacts);
    if (fromFacts) return fromFacts;
  }

  const needsLocation =
    intent === ACCESS_INTENT_TYPES.RESERVE || intent === ACCESS_INTENT_TYPES.LIST_SLOTS;
  const needsWindow = intent === ACCESS_INTENT_TYPES.RESERVE;
  const needsDay = intent === ACCESS_INTENT_TYPES.LIST_SLOTS;

  if (needsLocation && !String(partial.locationId || "").trim()) {
    return "Which amenity do you want? For example: game room tomorrow 5-7 pm.";
  }
  if (needsWindow && (!partial.startAt || !partial.endAt)) {
    return `What date and time do you want for ${locName}? For example: tomorrow 5-7 pm.`;
  }
  if (needsDay && !partial.dateForDay && !partial.startAt) {
    return `Which day should I check for ${locName}? For example: tomorrow.`;
  }

  return "";
}

module.exports = {
  buildAccessDeterministicReply,
};
