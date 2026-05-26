const { getSupabase } = require("../db/supabase");
const {
  twilioBroadcastFrom,
  commMainNumberDisplay,
} = require("../config/env");
const { sendTwilioMessage } = require("../outbound/twilioSendMessage");
const { appendEventLog } = require("../dal/appendEventLog");
const { getBrandContext } = require("./brandContextService");
const { appendFooter } = require("./messageComposer");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeCampaignRow(row) {
  return row && typeof row === "object" ? row : null;
}

async function sendCampaign(input) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const opts = input && typeof input === "object" ? input : {};
  const campaign = normalizeCampaignRow(opts.campaign);
  const campaignId = String((campaign && campaign.id) || opts.campaignId || "").trim();
  if (!campaignId) return { ok: false, error: "missing_campaign_id" };
  if (!campaign) return { ok: false, error: "missing_campaign_row" };

  const from = twilioBroadcastFrom();
  if (!from) return { ok: false, error: "missing_broadcast_from" };

  const { data: recipientRows, error: recipientError } = await sb
    .from("communication_recipients")
    .select("id, property_code, channel, phone_e164_snapshot, status")
    .eq("campaign_id", campaignId)
    .in("status", ["PENDING"]);
  if (recipientError) {
    return { ok: false, error: recipientError.message || "recipient_fetch_failed" };
  }

  if (!recipientRows || !recipientRows.length) {
    return { ok: false, error: "no_pending_recipients" };
  }

  const propertyCodes = Array.from(
    new Set(
      recipientRows
        .map((row) => String(row.property_code || "").trim().toUpperCase())
        .filter(Boolean)
    )
  );
  const brandContext = await getBrandContext({
    orgId: campaign.org_id || campaign.orgId,
    propertyCodes,
  });
  const isMultiProperty = propertyCodes.length > 1;

  const { error: sendingError } = await sb
    .from("communication_campaigns")
    .update({ status: "SENDING", updated_at: new Date().toISOString() })
    .eq("id", campaignId);
  if (sendingError) {
    return { ok: false, error: sendingError.message || "campaign_sending_update_failed" };
  }

  await appendEventLog({
    traceId: opts.traceId,
    log_kind: "communication",
    event: "COMM_SEND_STARTED",
    payload: {
      campaign_id: campaignId,
      recipient_count: recipientRows.length,
      property_codes: propertyCodes,
    },
  });

  let sent = 0;
  let failed = 0;

  for (const row of recipientRows) {
    const fullBody = appendFooter(
      campaign.message_body || campaign.messageBody || "",
      brandContext,
      row.property_code,
      commMainNumberDisplay(),
      campaign.language,
      { isMultiProperty }
    );
    const nowIso = new Date().toISOString();

    const result = await sendTwilioMessage({
      to: String(row.phone_e164_snapshot || "").trim(),
      body: fullBody,
      traceId: opts.traceId,
      channel: String(row.channel || "").trim().toLowerCase() === "whatsapp" ? "whatsapp" : "sms",
      from,
    });

    if (result.ok) {
      sent += 1;
      await sb
        .from("communication_recipients")
        .update({
          status: "SENT",
          twilio_message_sid: result.sid || null,
          queued_at: nowIso,
          sent_at: nowIso,
        })
        .eq("id", row.id);
    } else {
      failed += 1;
      await sb
        .from("communication_recipients")
        .update({
          status: "FAILED",
          error_message: String(result.error || "send_failed"),
          failed_at: nowIso,
        })
        .eq("id", row.id);
    }

    await sleep(100);
  }

  const finalStatus = sent > 0 && failed === 0 ? "SENT" : sent > 0 ? "PARTIALLY_SENT" : "FAILED";
  const sentAt = sent > 0 ? new Date().toISOString() : null;
  const { data: statusRows } = await sb
    .from("communication_recipients")
    .select("status")
    .eq("campaign_id", campaignId);

  let delivered = 0;
  for (const row of statusRows || []) {
    if (String(row.status || "").trim() === "DELIVERED") delivered += 1;
  }

  const { error: campaignUpdateError } = await sb
    .from("communication_campaigns")
    .update({
      status: finalStatus,
      total_sent: sent,
      total_failed: failed,
      total_delivered: delivered,
      sent_at: sentAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId);
  if (campaignUpdateError) {
    return {
      ok: false,
      error: campaignUpdateError.message || "campaign_finalize_failed",
      sent,
      failed,
    };
  }

  await appendEventLog({
    traceId: opts.traceId,
    log_kind: "communication",
    event: "COMM_SEND_COMPLETED",
    payload: {
      campaign_id: campaignId,
      sent,
      failed,
      final_status: finalStatus,
    },
  });

  return {
    ok: true,
    status: finalStatus,
    sent,
    failed,
  };
}

module.exports = {
  sendCampaign,
};
