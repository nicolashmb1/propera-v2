/**
 * Map staff expense capture confirm resolution → canonical Jarvis proposal for portal.
 */

const { verifyExpenseConfirmToken } = require("../../brain/staff/expenseConfirmToken");
const { normalizeProposalForPortal } = require("./types");
const { proposalFromExpenseDraft } = require("./attachTicketCost");

/**
 * @param {object | null} staffRun
 * @returns {object | null}
 */
function enrichStaffRunWithProposal(staffRun) {
  if (!staffRun || !staffRun.resolution) return staffRun;
  const res = staffRun.resolution;
  if (!res.needsConfirm || !res.confirmToken) return staffRun;

  const payload = verifyExpenseConfirmToken(res.confirmToken);
  if (!payload) return staffRun;

  const proposal = normalizeProposalForPortal(
    proposalFromExpenseDraft(payload, res.confirmSummary || staffRun.replyText || "")
  );
  proposal.confirm_token = res.confirmToken;

  return {
    ...staffRun,
    resolution: {
      ...res,
      proposal,
    },
  };
}

module.exports = { enrichStaffRunWithProposal };
