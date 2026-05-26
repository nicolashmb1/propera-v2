const { getSupabase } = require("../db/supabase");
const { appendEventLog } = require("../dal/appendEventLog");

function normalizeTwilioStatus(raw) {
  return String(raw || "").trim().toLowerCase();
}

function mapTwilioRecipientStatus(raw) {
  const status = normalizeTwilioStatus(raw);
  if (status === "delivered" || status === "read") return "DELIVERED";
  if (
    status === "failed" ||
    status === "undelivered" ||
    status === "canceled" ||
    status === "cancelled"
  ) {
    return "FAILED";
  }
  if (status === "sent" || status === "queued" || status === "accepted" || status === "sending") {
    return "SENT";
  }
  return "";
}

function shouldReplaceRecipientStatus(currentStatus, nextStatus) {
  const cur = String(currentStatus || "").trim().toUpperCase();
  const next = String(nextStatus || "").trim().toUpperCase();
  if (!next) return false;
  if (!cur) return true;
  if (cur === next) return false;
  if (cur === "DELIVERED") return next === "FAILED";
  if (cur === "FAILED") return false;
  if (cur === "SENT") return next === "DELIVERED" || next === "FAILED";
  if (cur === "PENDING" || cur === "QUEUED") return true;
  return true;
}

async function recomputeCampaignDeliveryTotals(sb, campaignId) {
  const { data, error } = await sb
    .from("communication_recipients")
    .select("status")
    .eq("campaign_id", String(campaignId || "").trim());
  if (error) {
    return { ok: false, error: error.message || "recipient_totals_failed" };
  }

  let totalSent = 0;
  let totalDelivered = 0;
  let totalFailed = 0;
  for (const row of data || []) {
    const status = String(row.status || "").trim().toUpperCase();
    if (status === "SENT" || status === "DELIVERED") totalSent += 1;
    if (status === "DELIVERED") totalDelivered += 1;
    if (status === "FAILED") totalFailed += 1;
  }

  let campaignStatus = "";
  if (totalSent > 0 && totalFailed === 0) campaignStatus = "SENT";
  else if (totalSent > 0 && totalFailed > 0) campaignStatus = "PARTIALLY_SENT";
  else if (totalSent === 0 && totalFailed > 0) campaignStatus = "FAILED";

  const patch = {
    total_sent: totalSent,
    total_delivered: totalDelivered,
    total_failed: totalFailed,
    updated_at: new Date().toISOString(),
  };
  if (campaignStatus) patch.status = campaignStatus;

  const { error: updateError } = await sb
    .from("communication_campaigns")
    .update(patch)
    .eq("id", String(campaignId || "").trim());
  if (updateError) {
    return { ok: false, error: updateError.message || "campaign_totals_update_failed" };
  }

  return {
    ok: true,
    totalSent,
    totalDelivered,
    totalFailed,
    campaignStatus,
  };
}

async function handleDeliveryCallback(input, opts) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const body = input && typeof input === "object" ? input : {};
  const messageSid = String(body.MessageSid || body.SmsSid || body.messageSid || "").trim();
  if (!messageSid) return { ok: false, error: "missing_message_sid" };

  const { data: recipient, error: lookupError } = await sb
    .from("communication_recipients")
    .select("id, campaign_id, status, twilio_message_sid")
    .eq("twilio_message_sid", messageSid)
    .maybeSingle();
  if (lookupError) return { ok: false, error: lookupError.message || "recipient_lookup_failed" };
  if (!recipient) return { ok: false, error: "recipient_not_found" };

  const nextStatus = mapTwilioRecipientStatus(body.MessageStatus || body.SmsStatus || body.status);
  if (!nextStatus) {
    return { ok: true, ignored: true };
  }

  if (!shouldReplaceRecipientStatus(recipient.status, nextStatus)) {
    return { ok: true, ignored: true };
  }

  const nowIso = new Date().toISOString();
  const patch = {
    status: nextStatus,
    error_code: String(body.ErrorCode || "").trim() || null,
    error_message: String(body.ErrorMessage || "").trim() || null,
  };
  if (nextStatus === "DELIVERED") patch.delivered_at = nowIso;
  if (nextStatus === "FAILED") patch.failed_at = nowIso;
  if (nextStatus === "SENT" && String(recipient.status || "").trim().toUpperCase() !== "SENT") {
    patch.sent_at = nowIso;
  }

  const { error: updateError } = await sb
    .from("communication_recipients")
    .update(patch)
    .eq("id", recipient.id);
  if (updateError) return { ok: false, error: updateError.message || "recipient_update_failed" };

  const totals = await recomputeCampaignDeliveryTotals(sb, recipient.campaign_id);
  if (!totals.ok) return totals;

  await appendEventLog({
    traceId: opts && opts.traceId,
    log_kind: "communication",
    event: "COMM_DELIVERY_CALLBACK",
    payload: {
      campaign_id: recipient.campaign_id,
      recipient_id: recipient.id,
      twilio_message_sid: messageSid,
      next_status: nextStatus,
      total_sent: totals.totalSent,
      total_delivered: totals.totalDelivered,
      total_failed: totals.totalFailed,
    },
  });

  return {
    ok: true,
    campaignId: recipient.campaign_id,
    recipientId: recipient.id,
    status: nextStatus,
  };
}

module.exports = {
  mapTwilioRecipientStatus,
  shouldReplaceRecipientStatus,
  recomputeCampaignDeliveryTotals,
  handleDeliveryCallback,
};
