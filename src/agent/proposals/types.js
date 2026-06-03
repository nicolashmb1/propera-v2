/**
 * Jarvis proposal contract (spine layer 3).
 * @see docs/JARVIS_SPINE.md
 */

const PROPOSAL_VERSION = "1";

/** @readonly */
const PROPOSAL_OPS = Object.freeze({
  ATTACH_TICKET_COST: "attach_ticket_cost",
  PROPOSE_VENDOR_REQUEST: "propose_vendor_request",
  APPEND_SERVICE_NOTE: "append_service_note",
});

/**
 * @param {object} o
 * @returns {object}
 */
function normalizeProposalForPortal(o) {
  const p = o || {};
  return {
    version: String(p.version || PROPOSAL_VERSION),
    proposal_id: String(p.proposal_id || p.proposalId || "").trim(),
    op: String(p.op || "").trim(),
    state: String(p.state || "awaiting_confirm").trim(),
    summary_human: String(p.summary_human || p.summaryHuman || "").trim(),
    target: p.target && typeof p.target === "object" ? p.target : {},
    payload: p.payload && typeof p.payload === "object" ? p.payload : {},
    approval_tier_suggested:
      p.approval_tier_suggested != null ? Number(p.approval_tier_suggested) : 2,
    confirm_token: String(p.confirm_token || p.confirmToken || "").trim(),
  };
}

module.exports = {
  PROPOSAL_VERSION,
  PROPOSAL_OPS,
  normalizeProposalForPortal,
};
