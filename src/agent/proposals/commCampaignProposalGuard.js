/**
 * Drop stale send_communication_campaign proposals when the draft campaign was deleted.
 */

const { getSupabase } = require("../../db/supabase");
const { markProposalOnThread } = require("../../dal/jarvisOperatorThreads");
const { PROPOSAL_OPS } = require("./types");
const { verifyProposalConfirmToken } = require("./proposalToken");

/**
 * @param {object | null | undefined} proposal
 */
function campaignIdFromProposal(proposal) {
  const token = String(proposal?.confirm_token || proposal?.confirmToken || "").trim();
  if (!token) return "";
  const verified = verifyProposalConfirmToken(token);
  const p = verified?.payload && typeof verified.payload === "object" ? verified.payload : {};
  return String(p.campaign_id || p.campaignId || "").trim();
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient | null | undefined} sb
 * @param {{ threadId?: string, proposal?: object } | null | undefined} hit
 * @returns {Promise<{ threadId?: string, proposal?: object } | null>}
 */
async function refreshCommCampaignProposalHit(sb, hit) {
  if (!hit?.proposal) return hit;
  const op = String(hit.proposal.op || "").trim();
  if (op !== PROPOSAL_OPS.SEND_COMMUNICATION_CAMPAIGN) return hit;

  const db = sb || getSupabase();
  const campaignId = campaignIdFromProposal(hit.proposal);
  const threadId = String(hit.threadId || "").trim();
  const proposalId = String(hit.proposal.proposal_id || "").trim();

  if (!campaignId) {
    if (db && threadId && proposalId) {
      await markProposalOnThread(db, { threadId, proposalId, state: "expired" });
    }
    return null;
  }

  if (!db) return hit;

  const { data, error } = await db
    .from("communication_campaigns")
    .select("id")
    .eq("id", campaignId)
    .maybeSingle();
  if (error || !data) {
    if (threadId && proposalId) {
      await markProposalOnThread(db, { threadId, proposalId, state: "expired" });
    }
    return null;
  }

  return hit;
}

module.exports = {
  campaignIdFromProposal,
  refreshCommCampaignProposalHit,
};
