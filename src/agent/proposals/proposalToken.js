/**
 * Signed proposal confirm tokens (extends expense confirm payload with `op`).
 */

const crypto = require("crypto");
const { PROPOSAL_OPS } = require("./types");
const {
  buildExpenseConfirmToken,
  verifyExpenseConfirmToken,
} = require("../../brain/staff/expenseConfirmToken");

/**
 * @param {object} payload — op-specific commit payload
 * @param {string} op
 */
function buildProposalConfirmToken(payload, op) {
  const body = {
    ...payload,
    op: String(op || PROPOSAL_OPS.ATTACH_TICKET_COST).trim(),
    proposal_id:
      String(payload.proposal_id || payload.proposalId || "").trim() ||
      crypto.randomUUID(),
  };
  return buildExpenseConfirmToken(body);
}

/**
 * @param {string} token
 * @returns {{ op: string, proposal_id: string, payload: object } | null}
 */
function verifyProposalConfirmToken(token) {
  const p = verifyExpenseConfirmToken(token);
  if (!p) return null;
  const op = String(p.op || PROPOSAL_OPS.ATTACH_TICKET_COST).trim();
  return {
    op,
    proposal_id: String(p.proposal_id || p.proposalId || "").trim(),
    payload: p,
  };
}

module.exports = {
  buildProposalConfirmToken,
  verifyProposalConfirmToken,
};
