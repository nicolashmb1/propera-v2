/**
 * Clear an awaiting_confirm Jarvis proposal (staff cancel / failed commit cleanup).
 */

const { getSupabase } = require("../../db/supabase");
const { jarvisThreadEnabled } = require("../../config/env");
const {
  findAwaitingProposalForActor,
  findThreadWithProposalForActor,
  markProposalOnThread,
} = require("../../dal/jarvisOperatorThreads");
const { verifyProposalConfirmToken } = require("./proposalToken");
const { refreshCommCampaignProposalHit } = require("./commCampaignProposalGuard");
const { appendEventLog } = require("../../dal/appendEventLog");

/**
 * @param {object} opts
 * @param {string} opts.staffActorKey
 * @param {string} [opts.confirmToken]
 * @param {string} [opts.traceId]
 * @param {string} [opts.reason] — rejected (staff) | failed (commit error)
 */
async function dismissJarvisPendingProposal(opts) {
  const staffActorKey = String(opts?.staffActorKey || "").trim();
  const confirmToken = String(opts?.confirmToken || "").trim();
  const traceId = String(opts?.traceId || "").trim();
  const reason = String(opts?.reason || "rejected").trim();
  const state = reason === "failed" ? "failed" : "rejected";

  if (!jarvisThreadEnabled()) {
    return { ok: true, dismissed: false, message: "Thread spine disabled." };
  }
  if (!staffActorKey) {
    return { ok: false, error: "missing_actor", message: "Staff actor required." };
  }

  const sb = getSupabase();
  if (!sb) {
    return { ok: false, error: "no_db", message: "Database is not configured." };
  }

  let hit = await refreshCommCampaignProposalHit(
    sb,
    await findAwaitingProposalForActor(sb, staffActorKey, "portal")
  );

  if (confirmToken) {
    const verified = verifyProposalConfirmToken(confirmToken);
    const proposalId = String(verified?.proposal_id || "").trim();
    if (proposalId) {
      const threadHit = await findThreadWithProposalForActor(
        sb,
        staffActorKey,
        "portal",
        proposalId
      );
      if (threadHit?.proposal?.state === "awaiting_confirm") {
        hit = {
          threadId: threadHit.threadId,
          proposal: threadHit.proposal,
        };
      }
    }
  }

  if (!hit?.proposal || String(hit.proposal.state || "") !== "awaiting_confirm") {
    return {
      ok: true,
      dismissed: false,
      message: "Nothing pending to cancel.",
    };
  }

  const proposal = hit.proposal;
  const proposalId = String(proposal.proposal_id || "").trim();
  const threadId = String(hit.threadId || "").trim();
  if (!threadId || !proposalId) {
    return { ok: false, error: "invalid_pending", message: "Could not resolve pending proposal." };
  }

  await markProposalOnThread(sb, {
    threadId,
    proposalId,
    state,
  });

  await appendEventLog({
    traceId,
    log_kind: "agent",
    event: "JARVIS_PLAN_DISMISSED",
    payload: {
      proposal_id: proposalId,
      op: proposal.op,
      state,
    },
  });

  const summary = String(proposal.summary_human || "").trim();
  return {
    ok: true,
    dismissed: true,
    op: String(proposal.op || "").trim(),
    proposal_id: proposalId,
    summary,
    message: summary
      ? `Cancelled pending action: ${summary}`
      : "Cancelled the pending proposal.",
  };
}

module.exports = { dismissJarvisPendingProposal };
