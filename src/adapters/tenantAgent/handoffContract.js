/**
 * Typed handoff payload validation gate — brain only accepts clean operational payloads.
 */
const MIN_ISSUE_LENGTH = 4;
const MAX_ISSUE_LENGTH = 500;

const META_ISSUE_PATTERNS = [
  /^request\s+for\s+clarification/i,
  /^clarification\s+(?:on|about|regarding)/i,
  /^(?:the\s+)?tenant\s+(?:is|has|wants?|asked?|says?|sent?|reports?)\b/i,
  /^(?:the\s+)?user\s+(?:is|has|wants?|asked?|says?|sent?|reports?)\b/i,
  /^could\s+you\s+(?:clarify|provide|confirm|tell\s+me)/i,
  /^can\s+you\s+(?:clarify|provide|confirm|tell\s+me)/i,
  /^please\s+(?:clarify|provide|confirm|describe|specify)/i,
  /^it\s+(?:appears|seems)\s+(?:that\s+)?the\s+tenant/i,
  /^this\s+(?:appears|seems)\s+to\s+be\s+(?:a\s+)?(?:request|message|inquiry)/i,
  /^(?:based\s+on|from)\s+the\s+(?:previous|prior|above|last)\s+message/i,
  /^(?:i'm|i\s+am)\s+(?:not\s+sure|unclear|unable\s+to)/i,
  /^no\s+specific\s+(?:issue|problem|request)/i,
  /^(?:the\s+)?(?:maintenance\s+)?request\s+(?:is|was|involves|relates)\b/i,
  /^(?:follow[\s-]?up|follow[\s-]?ing\s+up)\s+on\b/i,
  /^(?:they|tenant)\s+(?:mentioned|said|stated|reported|indicated)\b/i,
];

/**
 * @param {string} text
 * @returns {boolean}
 */
function isMetaIssueText(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return META_ISSUE_PATTERNS.some((re) => re.test(t));
}

/**
 * @param {object} partial
 * @param {{ knownPropertyCodesUpper?: Set<string> }} [opts]
 * @returns {{
 *   valid: boolean,
 *   rejectedFields: string[],
 *   rejectionReasons: string[],
 *   cleanPayload: object
 * }}
 */
function validateHandoffPayload(partial, opts) {
  const p = { ...(partial || {}) };
  const knownCodes =
    opts && opts.knownPropertyCodesUpper instanceof Set
      ? opts.knownPropertyCodesUpper
      : null;

  const rejected = [];
  const reasons = [];

  const issue = String(p.issue || "").trim();
  if (issue) {
    if (issue.length < MIN_ISSUE_LENGTH) {
      rejected.push("issue");
      reasons.push(`issue too short (${issue.length} chars, min ${MIN_ISSUE_LENGTH})`);
      delete p.issue;
    } else if (issue.length > MAX_ISSUE_LENGTH) {
      p.issue = issue.slice(0, MAX_ISSUE_LENGTH).trim();
    } else if (isMetaIssueText(issue)) {
      rejected.push("issue");
      reasons.push(`meta/system text in issue field: "${issue.slice(0, 80)}..."`);
      delete p.issue;
    }
  }

  const prop = String(p.property || "").trim().toUpperCase();
  if (prop && knownCodes && knownCodes.size > 0 && !knownCodes.has(prop)) {
    rejected.push("property");
    reasons.push(`property code "${prop}" not in known property list`);
    delete p.property;
  }

  const unit = String(p.unit || "").trim();
  if (unit && /^\d{5}$/.test(unit)) {
    rejected.push("unit");
    reasons.push(`unit "${unit}" is 5-digit-only and likely a ZIP code`);
    delete p.unit;
  }

  const cleanPayload = {};
  for (const [k, v] of Object.entries(p)) {
    if (!k.startsWith("_")) {
      cleanPayload[k] = v;
    }
  }

  return {
    valid: rejected.length === 0,
    rejectedFields: rejected,
    rejectionReasons: reasons,
    cleanPayload,
  };
}

/**
 * @param {string} firstRejectedField
 * @returns {string}
 */
function handoffRejectionPrompt(firstRejectedField) {
  switch (String(firstRejectedField || "")) {
    case "issue":
      return "What maintenance issue do you need help with?";
    case "property":
      return "Which property is this for?";
    case "unit":
      return "What's your unit number?";
    default:
      return "Can you describe the maintenance issue you need help with?";
  }
}

module.exports = {
  validateHandoffPayload,
  isMetaIssueText,
  handoffRejectionPrompt,
};
