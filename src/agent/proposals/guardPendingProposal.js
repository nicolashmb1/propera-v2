/**
 * Block a new voice propose when another confirm is already pending.
 */

const { getSupabase } = require("../../db/supabase");
const { jarvisThreadEnabled } = require("../../config/env");
const { findAwaitingProposalForActor } = require("../../dal/jarvisOperatorThreads");
const { refreshCommCampaignProposalHit } = require("./commCampaignProposalGuard");

/**
 * @param {object} ctx
 * @param {{ skipOps?: string[] }} [opts]
 * @returns {Promise<object | null>}
 */
async function guardPendingProposalBeforeNewPropose(ctx, opts) {
  if (!jarvisThreadEnabled()) return null;
  const actorKey = String(ctx?.staffActorKey || "").trim();
  if (!actorKey) return null;

  const sb = getSupabase();
  if (!sb) return null;

  const hit = await findAwaitingProposalForActor(sb, actorKey, "portal");
  const refreshed = await refreshCommCampaignProposalHit(sb, hit);
  const proposal = refreshed?.proposal;
  if (!proposal || String(proposal.state || "") !== "awaiting_confirm") return null;

  const op = String(proposal.op || "").trim();
  const skip = new Set((opts?.skipOps || []).map((x) => String(x || "").trim()));
  if (skip.has(op)) return null;

  const summary = String(proposal.summary_human || "").trim();
  const token = String(proposal.confirm_token || "").trim();
  const opLabel = op.replace(/_/g, " ");

  return {
    needs_confirm: true,
    already_pending: true,
    op,
    summary_human: summary,
    confirm_token: token,
    speak: summary
      ? `${summary} Confirm that first — then I'll do the next thing.`
      : `Confirm the pending ${opLabel} first — then I'll do the next thing.`,
  };
}

module.exports = { guardPendingProposalBeforeNewPropose };
