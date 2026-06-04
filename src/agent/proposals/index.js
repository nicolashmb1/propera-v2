const { PROPOSAL_VERSION, PROPOSAL_OPS, normalizeProposalForPortal } = require("./types");
const { buildProposalConfirmToken, verifyProposalConfirmToken } = require("./proposalToken");
const { commitProposal } = require("./commitProposal");
const { executeJarvisConfirm } = require("./executeJarvisConfirm");
const { enrichStaffRunWithProposal } = require("./enrichStaffRunWithProposal");
const {
  proposalFromExpenseDraft,
  buildAttachTicketCostProposal,
} = require("./attachTicketCost");
const {
  proposalFromVendorDraft,
  buildProposeVendorRequestProposal,
} = require("./proposeVendorRequest");

module.exports = {
  PROPOSAL_VERSION,
  PROPOSAL_OPS,
  normalizeProposalForPortal,
  buildProposalConfirmToken,
  verifyProposalConfirmToken,
  commitProposal,
  executeJarvisConfirm,
  enrichStaffRunWithProposal,
  proposalFromExpenseDraft,
  buildAttachTicketCostProposal,
  proposalFromVendorDraft,
  buildProposeVendorRequestProposal,
};
