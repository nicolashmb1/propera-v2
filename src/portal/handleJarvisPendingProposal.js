/**
 * GET /api/portal/jarvis/pending-proposal — awaiting confirm for staff actor (thread spine).
 */
const { getSupabase } = require("../db/supabase");
const {
  findAwaitingProposalForActor,
  loadJarvisThread,
} = require("../dal/jarvisOperatorThreads");
const { jarvisThreadEnabled, jarvisPlanEnabled } = require("../config/env");

function ticketFromScopeSnapshot(scopeSnapshot) {
  const anchor = scopeSnapshot?.anchor;
  if (!anchor || typeof anchor !== "object") return null;
  const humanTicketId = String(anchor.humanTicketId || anchor.human_ticket_id || "").trim();
  if (!humanTicketId) return null;
  return {
    humanTicketId,
    ticketRowId: String(anchor.ticketRowId || anchor.ticket_row_id || "").trim() || undefined,
    unitLabel: String(anchor.unit || anchor.unitLabel || "").trim() || undefined,
    propertyCode: String(anchor.propertyCode || anchor.property_code || "").trim() || undefined,
  };
}

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
async function handleJarvisPendingProposal(req, res) {
  if (!jarvisThreadEnabled() || !jarvisPlanEnabled()) {
    return res.json({ ok: true, pending: null });
  }

  const actorPhone = String(
    req.query.actorPhoneE164 || req.query.actorPhone || req.query.actor || ""
  ).trim();
  if (!actorPhone) {
    return res.status(400).json({ ok: false, error: "actorPhoneE164_required" });
  }

  const sb = getSupabase();
  if (!sb) {
    return res.status(503).json({ ok: false, error: "database_unavailable" });
  }

  const hit = await findAwaitingProposalForActor(sb, actorPhone, "portal");
  if (!hit?.proposal) {
    return res.json({ ok: true, pending: null });
  }

  const p = hit.proposal;
  if (String(p.state || "") !== "awaiting_confirm") {
    return res.json({ ok: true, pending: null });
  }

  const exp = p.expires_at ? new Date(String(p.expires_at)).getTime() : 0;
  if (exp && Date.now() > exp) {
    return res.json({ ok: true, pending: null, expired: true });
  }

  let ticket = null;
  if (hit.threadId) {
    const thread = await loadJarvisThread(sb, { threadId: hit.threadId });
    ticket = ticketFromScopeSnapshot(thread?.scopeSnapshot);
  }

  return res.json({
    ok: true,
    pending: {
      op: String(p.op || "").trim(),
      summary: String(p.summary_human || "").trim(),
      confirmToken: String(p.confirm_token || "").trim(),
      proposalId: String(p.proposal_id || "").trim(),
      expiresAt: p.expires_at || null,
      ticket,
    },
  });
}

module.exports = { handleJarvisPendingProposal, ticketFromScopeSnapshot };
