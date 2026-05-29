/**
 * attach_ticket_cost — first Jarvis proposal op (wraps staff expense capture commit).
 */

const { getSupabase } = require("../../db/supabase");
const { PROPOSAL_OPS } = require("./types");
const { buildProposalConfirmToken } = require("./proposalToken");

/**
 * @param {object} expensePayload — verified token payload
 * @param {string} summary
 */
function proposalFromExpenseDraft(expensePayload, summary) {
  const p = expensePayload || {};
  const ticketHumanId = String(p.ticketHumanId || "").trim();
  const ticketRowId = String(p.ticketRowId || "").trim();
  return {
    version: "1",
    proposal_id: String(p.proposal_id || "").trim() || ticketRowId || ticketHumanId,
    op: PROPOSAL_OPS.ATTACH_TICKET_COST,
    state: "awaiting_confirm",
    summary_human: String(summary || "").trim(),
    target: {
      ticket_row_id: ticketRowId,
      human_ticket_id: ticketHumanId,
    },
    payload: {
      vendor_amt_cents: Number(p.vendorAmt) || 0,
      tenant_amt_cents: Number(p.tenantAmt) || 0,
      has_tenant_charge: p.hasTenantCharge === true,
      entry_type: String(p.entryType || "parts"),
      vendor_name: String(p.vendorName || ""),
    },
    approval_tier_suggested: 2,
    confirm_token: "",
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {object} verified — from verifyProposalConfirmToken
 * @param {object} ctx
 */
async function commitAttachTicketCost(sb, verified, ctx) {
  const { executeConfirmedExpenseCapture } = require("../../dal/staffExpenseCapture");
  const run = await executeConfirmedExpenseCapture(sb, verified.payload, ctx);
  return {
    ...run,
    brain: run.brain || "jarvis_plan",
    resolution: {
      ...(run.resolution || {}),
      committed_op: PROPOSAL_OPS.ATTACH_TICKET_COST,
      proposal_id: verified.proposal_id,
    },
  };
}

/**
 * Build confirm token + portal proposal from expense draft fields.
 * @param {object} draft
 * @param {string} summary
 */
function buildAttachTicketCostProposal(draft, summary) {
  const token = buildProposalConfirmToken(draft, PROPOSAL_OPS.ATTACH_TICKET_COST);
  const proposal = proposalFromExpenseDraft(
    { ...draft, proposal_id: draft.proposal_id },
    summary
  );
  proposal.confirm_token = token;
  return { proposal, confirmToken: token };
}

module.exports = {
  proposalFromExpenseDraft,
  commitAttachTicketCost,
  buildAttachTicketCostProposal,
};
