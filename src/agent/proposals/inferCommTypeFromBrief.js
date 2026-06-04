/**
 * Infer communication_campaign.comm_type from staff brief (Jarvis / portal).
 * @see docs/COMMUNICATION_ENGINE.md
 */

const COMM_TYPES = new Set([
  "BUILDING_UPDATE",
  "MAINTENANCE_NOTICE",
  "POLICY_REMINDER",
  "EMERGENCY_ALERT",
  "LEASE_ADMIN",
]);

/**
 * @param {string} brief
 * @param {string} [override]
 * @returns {string}
 */
function inferCommTypeFromBrief(brief, override) {
  const raw = String(override || "")
    .trim()
    .toUpperCase();
  if (raw && COMM_TYPES.has(raw)) return raw;

  const b = String(brief || "").toLowerCase();
  if (/\b(emergency|urgent|immediate danger|evacuat|fire alarm|gas leak|danger)\b/.test(b)) {
    return "EMERGENCY_ALERT";
  }
  if (
    /\b(parking|policy|rule|rules|must|required|prohibited|belongings|belonging|pet|quiet hours|lease violation|remove all|clear out|no storage)\b/.test(
      b
    )
  ) {
    return "POLICY_REMINDER";
  }
  if (
    /\b(maintenance|repair|shutoff|shut off|water off|elevator|outage|inspection|service interruption)\b/.test(
      b
    )
  ) {
    return "MAINTENANCE_NOTICE";
  }
  if (/\b(lease|rent|renewal|move out|move-out|move in|move-in)\b/.test(b)) {
    return "LEASE_ADMIN";
  }
  return "BUILDING_UPDATE";
}

module.exports = { inferCommTypeFromBrief, COMM_TYPES };
