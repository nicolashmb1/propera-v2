const { registerConflictMediationRoutes } = require("./registerConflictMediationRoutes");
const {
  listConflictCasesForPortal,
  getConflictCaseDetailForPortal,
  listConflictPoliciesForPortal,
} = require("./conflictCaseRead");
const {
  reportPolicyViolation,
  issuePolicyNotice,
  previewPolicyNotice,
} = require("./conflictCaseWrite");
const { buildConflictCourtesyNotice } = require("./conflictNoticeOutgate");

module.exports = {
  registerConflictMediationRoutes,
  listConflictCasesForPortal,
  getConflictCaseDetailForPortal,
  listConflictPoliciesForPortal,
  reportPolicyViolation,
  issuePolicyNotice,
  previewPolicyNotice,
  buildConflictCourtesyNotice,
};
