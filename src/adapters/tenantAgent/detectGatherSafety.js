/**
 * Gather-phase safety — LLM judgment only (no keyword/regex emergency scan in the agent).
 */

const {
  inferContextualGatherSafety,
  isExplicitNonEmergencyCorrection,
} = require("./inferContextualGatherSafety");

const SCHEDULE_ASK_RE =
  /\b(preferred\s+(time|visit)|visit\s+(time|window)|when\s+(can|should|works|would)|what\s+time\s+(works|would|works best)|maintenance\s+to\s+come|come\s+by|schedule\s+a\s+visit|time\s+would\s+you\s+prefer)\b/i;

/**
 * @param {unknown} raw — from LLM `safety_assessment`
 * @returns {{ isEmergency: boolean, emergencyType?: string, skipScheduling?: boolean, requiresImmediateInstructions?: boolean, receiptTier?: 'emergency'|'urgent' } | undefined}
 */
function normalizeLlmSafetyAssessment(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object") {
    return { isEmergency: false };
  }

  const isEmergency = raw.is_emergency === true || raw.isEmergency === true;
  if (!isEmergency) {
    return { isEmergency: false };
  }

  const emType = String(raw.emergency_type || raw.emergencyType || "SAFETY")
    .trim()
    .toUpperCase();
  const gasLike = emType === "GAS" || /\bGAS\b/.test(emType);
  const coLike = emType === "CO" || /\bCO\b/.test(emType) || /CARBON MONOXIDE/.test(emType);
  const fireLike = emType === "FIRE" || emType === "SMOKE";
  const floodLike = emType === "FLOOD";
  const lifeSafety =
    gasLike ||
    coLike ||
    fireLike ||
    floodLike ||
    emType === "SEWAGE" ||
    emType === "ELECTRICAL" ||
    emType === "INJURY" ||
    emType === "NO_AC" ||
    emType === "NO_HEAT";
  const skipScheduling =
    raw.skip_scheduling !== false && raw.skipScheduling !== false;
  const requiresImmediateInstructions =
    raw.requires_immediate_instructions === true ||
    raw.requiresImmediateInstructions === true ||
    gasLike ||
    coLike ||
    fireLike;

  return {
    isEmergency: true,
    emergencyType: emType || "SAFETY",
    skipScheduling,
    requiresImmediateInstructions,
    receiptTier: lifeSafety ? "emergency" : "urgent",
  };
}

/**
 * @param {object} partial
 * @returns {{ isEmergency: boolean, emergencyType: string, skipScheduling: boolean, requiresImmediateInstructions: boolean, receiptTier: 'emergency'|'urgent' } | null}
 */
function getGatherSafety(partial) {
  const s = partial && partial._safety;
  if (!s || !s.isEmergency) return null;
  return s;
}

/**
 * Apply LLM safety assessment for this turn. Does not keyword-scan message text.
 * @param {object} partial
 * @param {string} bodyText
 * @param {object | null | undefined} parsedSafety — from LLM; undefined = no LLM update this turn
 * @param {string[]} [conversationUserTexts] — user lines for contextual backstop
 * @returns {object}
 */
function mergeGatherSafety(partial, bodyText, parsedSafety, conversationUserTexts) {
  const next = { ...(partial || {}) };

  let normalized =
    parsedSafety !== undefined ? normalizeLlmSafetyAssessment(parsedSafety) : undefined;

  const llmExplicitNonEmergency =
    parsedSafety !== undefined &&
    normalizeLlmSafetyAssessment(parsedSafety)?.isEmergency === false &&
    isExplicitNonEmergencyCorrection(bodyText);

  if (!normalized?.isEmergency && !llmExplicitNonEmergency) {
    const texts = Array.isArray(conversationUserTexts) ? conversationUserTexts : [];
    const contextual = inferContextualGatherSafety(texts, bodyText);
    if (contextual) normalized = contextual;
  }

  if (parsedSafety === undefined && !normalized?.isEmergency) {
    return next;
  }

  if (!normalized?.isEmergency) {
    delete next._safety;
    delete next._safety_ack_sent;
    return next;
  }

  next._safety = normalized;
  delete next.preferredWindow;
  delete next.preferred_window;
  if (normalized.skipScheduling) {
    delete next._schedule_retry_pending;
  }
  return next;
}

/**
 * @param {string} llmReply
 * @returns {boolean}
 */
function llmReplyAsksForSchedule(llmReply) {
  return SCHEDULE_ASK_RE.test(String(llmReply || ""));
}

module.exports = {
  normalizeLlmSafetyAssessment,
  getGatherSafety,
  mergeGatherSafety,
  llmReplyAsksForSchedule,
};
