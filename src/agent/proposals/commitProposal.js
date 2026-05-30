/**
 * Route validated proposals to brain commit paths.
 */

const { getSupabase } = require("../../db/supabase");
const { PROPOSAL_OPS } = require("./types");
const { commitAttachTicketCost } = require("./attachTicketCost");
const { commitProposeVendorRequest } = require("./proposeVendorRequest");

/**
 * @param {{ op: string, proposal_id: string, payload: object }} verified
 * @param {object} ctx
 */
async function commitProposal(verified, ctx) {
  const op = String(verified?.op || "").trim();
  const sb = getSupabase();
  if (!sb) {
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: "Database is not configured.",
    };
  }

  switch (op) {
    case PROPOSAL_OPS.ATTACH_TICKET_COST:
      return commitAttachTicketCost(sb, verified, ctx);
    case PROPOSAL_OPS.PROPOSE_VENDOR_REQUEST:
      return commitProposeVendorRequest(sb, verified, ctx);
    default:
      return {
        ok: false,
        brain: "jarvis_plan",
        replyText: `Unknown proposal operation: ${op || "?"}`,
      };
  }
}

module.exports = { commitProposal };
