/**
 * GAS `buildLifecycleFacts_` — `12_LIFECYCLE_ENGINE.gs` (Postgres shape).
 */

/**
 * @param {object|null} wi — row from `work_items`
 * @param {object} signal
 * @param {Date} now
 */
function buildLifecycleFacts(wi, signal, now) {
  const facts = {
    now: now instanceof Date ? now : new Date(),
    eventType: String((signal && signal.eventType) || "").trim().toUpperCase(),
    wiId: String((signal && signal.wiId) || "").trim(),
    propertyId: String((signal && signal.propertyId) || "").trim().toUpperCase(),
    scheduledEndAt: null,
    currentState: null,
    substate: null,
    phoneE164: null,
    ticketKey: null,
    metadataJson: null,
    outcome: null,
    timerType: null,
    timerPayload: null,
    partsEtaAt: null,
    partsEtaText: null,
  };

  if (wi) {
    facts.currentState = String(wi.state || "").trim().toUpperCase() || null;
    facts.substate = String(wi.substate || "").trim();
    facts.phoneE164 = String(wi.phone_e164 || "").trim();
    facts.metadataJson = wi.metadata_json;
    if (wi.ticket_key != null && String(wi.ticket_key).trim()) {
      facts.ticketKey = String(wi.ticket_key).trim();
    }
  }

  if (signal && signal.scheduledEndAt) {
    const d =
      signal.scheduledEndAt instanceof Date
        ? signal.scheduledEndAt
        : new Date(signal.scheduledEndAt);
    facts.scheduledEndAt = d;
  }
  if (signal && signal.outcome)
    facts.outcome = String(signal.outcome || "").trim().toUpperCase();
  if (signal && signal.timerType)
    facts.timerType = String(signal.timerType || "").trim().toUpperCase();
  if (signal && signal.payload) facts.timerPayload = signal.payload;
  if (signal && signal.partsEtaAt != null) {
    const d =
      signal.partsEtaAt instanceof Date
        ? signal.partsEtaAt
        : new Date(signal.partsEtaAt);
    facts.partsEtaAt = isFinite(d.getTime()) ? d : null;
  }
  if (signal && signal.partsEtaText != null) {
    facts.partsEtaText = String(signal.partsEtaText || "").trim();
  }

  return facts;
}

module.exports = { buildLifecycleFacts };
