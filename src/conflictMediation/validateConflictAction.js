/**
 * CME brain validation — tier, state, and permission checks before writes.
 * @see docs/CONFLICT_MEDIATION_ENGINE.md
 */

const CME2_NOTICE_TIER = "COURTESY";

/** States that may receive a first courtesy notice (CME-2). */
const CME2_ISSUE_NOTICE_FROM_STATES = new Set(["CASE_OPEN", "NOTICE_DRAFTED"]);

/**
 * @param {object} caseRow — DB row
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function validateIssueCourtesyNotice(caseRow) {
  if (!caseRow) return { ok: false, error: "not_found" };

  const state = String(caseRow.state || "").trim().toUpperCase();
  if (!CME2_ISSUE_NOTICE_FROM_STATES.has(state)) {
    return { ok: false, error: "invalid_case_state_for_notice" };
  }

  if (state === "NOTICE_SENT" || state === "MONITORING" || state === "ESCALATED") {
    return { ok: false, error: "notice_already_sent" };
  }

  if (!caseRow.policy_id) {
    return { ok: false, error: "policy_required" };
  }

  const existingTier = caseRow.current_notice_tier
    ? String(caseRow.current_notice_tier).trim().toUpperCase()
    : "";
  if (existingTier && existingTier !== CME2_NOTICE_TIER) {
    return { ok: false, error: "cme2_courtesy_tier_only" };
  }

  return { ok: true, tier: CME2_NOTICE_TIER };
}

/**
 * @param {object} body
 * @returns {{ ok: true, payload: object } | { ok: false, error: string }}
 */
function validateReportPolicyViolationBody(body) {
  const b = body && typeof body === "object" ? body : {};
  const propertyCode = String(b.propertyCode || b.property_code || "")
    .trim()
    .toUpperCase();
  const subjectUnit = String(b.subjectUnit || b.subject_unit || "").trim();
  const summary = String(b.summary || b.description || "").trim();

  if (!propertyCode) return { ok: false, error: "missing_property_code" };
  if (!subjectUnit) return { ok: false, error: "missing_subject_unit" };
  if (!summary) return { ok: false, error: "missing_summary" };

  const policyId = String(b.policyId || b.policy_id || "").trim() || null;

  return {
    ok: true,
    payload: {
      propertyCode,
      subjectUnit,
      summary,
      policyId,
      openedBy: String(b.openedBy || b.opened_by || b.actor || "PORTAL").trim() || "PORTAL",
      subjectTenantRosterId:
        String(b.subjectTenantRosterId || b.subject_tenant_roster_id || "").trim() || null,
    },
  };
}

module.exports = {
  CME2_NOTICE_TIER,
  CME2_ISSUE_NOTICE_FROM_STATES,
  validateIssueCourtesyNotice,
  validateReportPolicyViolationBody,
};
