/**
 * send_communication_campaign — Jarvis propose → confirm → Communication Engine send.
 * @see docs/COMMUNICATION_ENGINE.md · docs/JARVIS_SPINE.md
 */

const crypto = require("crypto");
const { appendEventLog } = require("../../dal/appendEventLog");
const { sendCampaignNow } = require("../../communication/campaignService");
const { PROPOSAL_OPS } = require("./types");
const { buildProposalConfirmToken } = require("./proposalToken");

/**
 * @param {object} draft
 * @param {string} summary
 */
function proposalFromSendCommunicationCampaignDraft(draft, summary) {
  const d = draft || {};
  return {
    version: "1",
    proposal_id: String(d.proposal_id || crypto.randomUUID()).trim(),
    op: PROPOSAL_OPS.SEND_COMMUNICATION_CAMPAIGN,
    state: "awaiting_confirm",
    summary_human: String(summary || d.summary || "").trim(),
    target: {
      campaign_id: String(d.campaignId || d.campaign_id || "").trim(),
      audience_kind: String(d.audienceKind || d.audience_kind || "").trim(),
    },
    payload: {
      campaign_id: String(d.campaignId || d.campaign_id || "").trim(),
      title: String(d.title || "").trim(),
      brief: String(d.brief || "").trim(),
      comm_type: String(d.commType || d.comm_type || "BUILDING_UPDATE").trim(),
      audience_kind: String(d.audienceKind || d.audience_kind || "").trim(),
      audience_filter:
        d.audienceFilter && typeof d.audienceFilter === "object" ? d.audienceFilter : {},
      message_body: String(d.messageBody || d.message_body || "").trim(),
      audience_label: String(d.audienceLabel || d.audience_label || "").trim(),
      will_send: Number(d.willSend ?? d.will_send ?? 0),
      skipped_no_phone: Number(d.skippedNoPhone ?? d.skipped_no_phone ?? 0),
      skipped_opt_out: Number(d.skippedOptOut ?? d.skipped_opt_out ?? 0),
      final_message_preview: String(
        d.finalMessagePreview || d.final_message_preview || ""
      ).trim(),
      sms_segments: Number(d.smsSegments ?? d.sms_segments ?? 1) || 1,
      property_code: String(d.propertyCode || d.property_code || "")
        .trim()
        .toUpperCase(),
      unit_label: String(d.unitLabel || d.unit_label || "").trim(),
      tenant_name: String(d.tenantName || d.tenant_name || "").trim(),
      delivery_mode: String(
        d.audienceFilter?.delivery_mode || d.delivery_mode || "sms_only"
      ).trim(),
      recipients_sample: Array.isArray(d.recipientsSample || d.recipients_sample)
        ? (d.recipientsSample || d.recipients_sample).slice(0, 8)
        : [],
    },
    approval_tier_suggested: 3,
    confirm_token: "",
  };
}

/**
 * @param {object} draft
 * @param {string} [summary]
 */
function buildSendCommunicationCampaignProposal(draft, summary) {
  const proposalId = crypto.randomUUID();
  const body = { ...draft, proposal_id: proposalId };
  const token = buildProposalConfirmToken(body, PROPOSAL_OPS.SEND_COMMUNICATION_CAMPAIGN);
  const proposal = proposalFromSendCommunicationCampaignDraft(body, summary || draft.summary);
  proposal.confirm_token = token;
  return { proposal, confirmToken: token };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} _sb
 * @param {{ op: string, proposal_id: string, payload: object }} verified
 * @param {{ traceId?: string }} ctx
 */
async function commitSendCommunicationCampaign(_sb, verified, ctx) {
  const p = verified?.payload || {};
  const campaignId = String(p.campaign_id || p.campaignId || "").trim();
  if (!campaignId) {
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: "Missing campaign id on this proposal.",
    };
  }

  const sent = await sendCampaignNow(campaignId, { traceId: ctx?.traceId });
  if (!sent.ok) {
    const err = String(sent.error || "send_failed");
    const msg =
      err === "not_found"
        ? "That broadcast draft was removed from Communications. Ask Jarvis to draft a new message."
        : err === "no_sendable_recipients"
          ? "No tenants would receive this message — the draft is still saved under Communications."
          : err === "campaign_not_sendable"
            ? "That campaign is no longer sendable. Check Communications for its status."
            : `Could not send the broadcast (${err}). The draft is still saved under Communications.`;
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: msg,
      resolution: { error: err, campaign_id: campaignId },
    };
  }

  const campaign = sent.campaign || {};
  const send = sent.send || {};
  const sentCount = Number(send.sent ?? campaign.totalSent ?? 0);
  const failedCount = Number(send.failed ?? campaign.totalFailed ?? 0);

  await appendEventLog({
    traceId: ctx?.traceId,
    log_kind: "agent",
    event: "JARVIS_COMM_CAMPAIGN_SENT",
    payload: {
      campaign_id: campaignId,
      proposal_id: verified.proposal_id,
      status: String(send.status || campaign.status || "").trim(),
      sent: sentCount,
      failed: failedCount,
      agent_initiated: true,
    },
  });

  const bits = [`Broadcast sent to ${sentCount} tenant${sentCount === 1 ? "" : "s"}.`];
  if (failedCount > 0) bits.push(`${failedCount} failed.`);
  bits.push(`Campaign saved in Communications.`);

  return {
    ok: true,
    brain: "jarvis_plan",
    replyText: bits.join(" "),
    resolution: {
      committed_op: PROPOSAL_OPS.SEND_COMMUNICATION_CAMPAIGN,
      campaign_id: campaignId,
      campaign_status: String(send.status || campaign.status || "").trim(),
      sent: sentCount,
      failed: failedCount,
    },
  };
}

module.exports = {
  proposalFromSendCommunicationCampaignDraft,
  buildSendCommunicationCampaignProposal,
  commitSendCommunicationCampaign,
};
