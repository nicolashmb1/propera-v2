/**
 * Deterministic out-of-scope detection for tenant inbound messages.
 * Fires only when no maintenance draft exists (ISSUE stage, fresh intake).
 * Non-maintenance topics: billing, amenity hours, lease, packages.
 */
const OOS_RULES = [
  {
    pattern:
      /\b(?:invoice|billing|rent\s+(?:invoice|statement|copy|receipt)|copy\s+of\s+(?:my\s+)?(?:invoice|bill|statement|receipt)|rent\s+payment|pay\s+(?:my\s+)?rent|late\s+fee|account\s+statement)\b/i,
    label: "billing or invoices",
  },
  {
    pattern:
      /\b(?:gym|pool|swimming\s+pool|fitness\s+(?:center|room)|game\s+room|clubhouse|rooftop|amenity|amenities)\b[\s\S]{0,60}\b(?:open|hours|close|until|when|available|schedule)\b/i,
    label: "amenity hours",
  },
  {
    pattern:
      /\bwhat\s+time\b[\s\S]{0,40}\b(?:gym|pool|fitness|game\s+room|clubhouse|office)\b/i,
    label: "amenity hours",
  },
  {
    pattern:
      /\b(?:lease\s+(?:renewal|termination|break|copy)|move[\s-]?out\s+(?:date|notice|form)|notice\s+to\s+(?:vacate|quit)|eviction\s+notice|early\s+(?:lease\s+)?termination)\b/i,
    label: "lease questions",
  },
  {
    pattern:
      /\b(?:(?:my|the|a)\s+)?(?:package|parcel)\s+(?:not\s+)?(?:delivered|arrived|received|missing)\b|\b(?:missing|lost)\s+(?:package|parcel)\b|\b(?:amazon|ups|fedex|usps)\s+(?:package|delivery)\b/i,
    label: "package deliveries",
  },
];

/**
 * @param {string} bodyText
 * @returns {{ label: string, deflectMessage: string } | null}
 */
function detectOutOfScopeIntent(bodyText) {
  const t = String(bodyText || "").trim();
  if (!t) return null;

  for (const { pattern, label } of OOS_RULES) {
    if (pattern.test(t)) {
      return {
        label,
        deflectMessage: `I can only help with maintenance requests right now. For ${label}, please contact the office directly.`,
      };
    }
  }
  return null;
}

module.exports = { detectOutOfScopeIntent };
