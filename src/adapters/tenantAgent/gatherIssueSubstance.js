/**
 * Gather issue slot — must describe what's wrong, not intake boilerplate alone.
 */
const { hasProblemSignal } = require("../../brain/core/splitIssueGroups");

const GENERIC_INTAKE_ONLY_RE =
  /^(?:hey[,!.\s]*)?(?:hi[,!.\s]*)?(?:i\s+)?(?:need|want)\s+(?:a\s+)?(?:service\s+request|maintenance(?:\s+request|\s+visit)?|repair\s+request|work\s+order|someone\s+to\s+(?:come|check))\s*[.!?]*$/i;

const GENERIC_ISSUE_BOILERPLATE_RE =
  /^(?:request for )?(?:service\s+)?(?:assistance|request|visit)|general\s+(?:maintenance\s+)?(?:service\s+)?request|maintenance\s+(?:service\s+)?request|tenant\s+(?:needs?|requested)\s+(?:a\s+)?(?:service|maintenance)/i;

/**
 * Tenant named the channel but not a symptom (no leak, broken, etc.).
 * @param {string} text
 * @returns {boolean}
 */
function isGenericMaintenanceIntakePhrase(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (hasProblemSignal(t) && !GENERIC_INTAKE_ONLY_RE.test(t)) return false;
  if (GENERIC_INTAKE_ONLY_RE.test(t)) return true;
  if (GENERIC_ISSUE_BOILERPLATE_RE.test(t)) return true;
  if (
    t.length <= 56 &&
    /\b(service request|maintenance request|work order|need maintenance)\b/i.test(t) &&
    !hasProblemSignal(t)
  ) {
    return true;
  }
  return false;
}

/**
 * @param {string} issue
 * @returns {boolean}
 */
function isSubstantiveMaintenanceIssue(issue) {
  const t = String(issue || "").trim();
  if (!t || t.length < 3) return false;
  return !isGenericMaintenanceIntakePhrase(t);
}

module.exports = {
  isGenericMaintenanceIntakePhrase,
  isSubstantiveMaintenanceIssue,
};
