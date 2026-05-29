/**
 * Single agent-side pipeline: merge slots → align day → handoff package.
 */
const { ACCESS_INTENT_TYPES, dateForDayToAnchorIso } = require("../../access/parseAccessIntent");
const {
  alignAccessWindowToDateForDay,
  accessHandoffReady,
} = require("./accessGatherRules");

function mapIntentToAccessType(intent) {
  const v = String(intent || "").trim();
  if (!v || v === "ACCESS_CLARIFY") return v;
  if (Object.values(ACCESS_INTENT_TYPES).includes(v)) return v;
  return ACCESS_INTENT_TYPES.UNKNOWN;
}

/**
 * @param {object} partial
 * @param {string} intentType
 */
function buildAccessHandoffPayload(partial, intentType) {
  const intent = mapIntentToAccessType(intentType);
  const payload = {
    intentType: intent,
    locationHint: String(partial.locationHint || "").trim(),
    locationId: String(partial.locationId || "").trim(),
    startAt: String(partial.startAt || "").trim(),
    endAt: String(partial.endAt || "").trim(),
    dateForDay: String(partial.dateForDay || "").trim(),
    cancelReservationId: String(partial._cancelReservationId || "").trim(),
  };

  if (intent === ACCESS_INTENT_TYPES.LIST_SLOTS && !payload.dateForDay) {
    payload.dateForDay = "tomorrow";
  }
  if (intent === ACCESS_INTENT_TYPES.LIST_SLOTS) {
    const anchor = dateForDayToAnchorIso(payload.dateForDay || "tomorrow", new Date());
    payload.startAt = anchor;
    payload.endAt = anchor;
  }

  return payload;
}

/**
 * Align reserve window to dateForDay before handoff.
 * @param {object} partial
 * @param {string} handoffIntent
 */
function finalizeAccessPartialForHandoff(partial, handoffIntent) {
  let p = { ...(partial || {}) };
  if (
    handoffIntent === ACCESS_INTENT_TYPES.RESERVE &&
    p.dateForDay &&
    p.startAt &&
    p.endAt
  ) {
    p = alignAccessWindowToDateForDay(p);
  }
  return p;
}

/**
 * Rules-only handoff gate (LLM does not decide calendar truth).
 * @param {object} partial
 * @param {string} intentType
 * @param {{ confirmReserve?: boolean, forceList?: boolean }} [opts]
 */
function shouldHandoffAccess(partial, intentType, opts = {}) {
  const intent = mapIntentToAccessType(intentType);
  if (intent === "ACCESS_CLARIFY" || !intent || intent === ACCESS_INTENT_TYPES.UNKNOWN) {
    return false;
  }
  if (opts.forceList && intent === ACCESS_INTENT_TYPES.LIST_SLOTS) {
    return accessHandoffReady(partial, ACCESS_INTENT_TYPES.LIST_SLOTS);
  }
  if (opts.confirmReserve) {
    return accessHandoffReady(partial, ACCESS_INTENT_TYPES.RESERVE);
  }
  return accessHandoffReady(partial, intent);
}

module.exports = {
  mapIntentToAccessType,
  buildAccessHandoffPayload,
  finalizeAccessPartialForHandoff,
  shouldHandoffAccess,
};
