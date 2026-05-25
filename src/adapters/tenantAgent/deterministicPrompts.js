/**
 * Deterministic gather prompts when TENANT_AGENT_LLM_ENABLED=0 (Sprint 1).
 * Property names come from `propertiesList` (DB) — short_name / display_name_short first.
 */
const {
  propertyTenantLabel,
  propertyTenantLabelFromList,
} = require("./gatherGreetingReply");

/**
 * @param {Array<{ property_code?: string, display_name?: string }>} candidates
 * @returns {string}
 */
function buildPropertyDisambiguationPrompt(candidates) {
  const rows = (candidates || [])
    .map((c) => String(c.display_name || c.property_code || "").trim())
    .filter(Boolean);
  if (rows.length === 0) return "Which building is this for?";
  if (rows.length === 1) {
    return `Just confirming — is this for ${rows[0]}?`;
  }
  const list = rows.slice();
  const last = list.pop();
  return `Which location is this for — ${list.join(", ")}, or ${last}?`;
}

/**
 * @param {object[]} [propertiesList]
 * @returns {string}
 */
function buildPropertyAsk(propertiesList) {
  const names = (propertiesList || [])
    .map((p) => propertyTenantLabel(p))
    .filter(Boolean);

  if (names.length === 0 || names.length === 1) {
    return "Which building is this for?";
  }
  if (names.length <= 8) {
    const list = names.slice();
    const last = list.pop();
    return `Which building is this for — ${list.join(", ")}, or ${last}?`;
  }
  return "Which building is this for?";
}

/**
 * @param {string | null} missing
 * @param {object} [partial]
 * @param {object[]} [propertiesList]
 * @returns {string}
 */
function promptForMissingField(missing, partial, propertiesList) {
  const propCode = String((partial && partial.property) || "").trim();
  const propLabel =
    propertyTenantLabelFromList(propertiesList, propCode) ||
    propCode.toUpperCase();
  const candidates = Array.isArray(partial && partial._property_candidates)
    ? partial._property_candidates
    : [];

  switch (String(missing || "").toLowerCase()) {
    case "property":
      if (candidates.length > 1) {
        return buildPropertyDisambiguationPrompt(candidates);
      }
      return buildPropertyAsk(propertiesList);
    case "unit":
      return propLabel
        ? `What's your unit number at ${propLabel}?`
        : "What's your unit number?";
    case "issue":
      return "What's going on? A short description of the maintenance issue is fine.";
    case "schedule":
      return "When works for a maintenance visit to your unit? Any day or time you prefer is fine.";
    default:
      return "Tell us the building, unit, what's wrong, and when works for a visit — we'll get it logged.";
  }
}

module.exports = {
  promptForMissingField,
  buildPropertyAsk,
  buildPropertyDisambiguationPrompt,
};
