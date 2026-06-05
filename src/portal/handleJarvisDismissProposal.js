/**
 * POST /api/portal/jarvis/dismiss-proposal — cancel awaiting confirm (unstick staff).
 */
const { jarvisThreadEnabled, jarvisPlanEnabled } = require("../config/env");
const { dismissJarvisPendingProposal } = require("../agent/proposals/dismissJarvisPendingProposal");

async function handleJarvisDismissProposal(req, res) {
  if (!jarvisThreadEnabled() || !jarvisPlanEnabled()) {
    return res.json({ ok: true, dismissed: false });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const actorPhone = String(
    body.actorPhoneE164 || body.actorPhone || req.query?.actorPhoneE164 || ""
  ).trim();
  const confirmToken = String(body.confirmToken || body.confirm_token || "").trim();

  if (!actorPhone) {
    return res.status(400).json({ ok: false, error: "actorPhoneE164_required" });
  }

  const result = await dismissJarvisPendingProposal({
    staffActorKey: actorPhone,
    confirmToken: confirmToken || undefined,
    traceId: String(req.traceId || ""),
    reason: "rejected",
  });

  if (!result.ok) {
    return res.status(400).json(result);
  }

  return res.json({
    ok: true,
    dismissed: result.dismissed === true,
    message: result.message,
    op: result.op,
    proposal_id: result.proposal_id,
  });
}

module.exports = { handleJarvisDismissProposal };
