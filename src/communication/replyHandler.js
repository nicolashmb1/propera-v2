const { getSupabase } = require("../db/supabase");
const {
  twilioBroadcastFrom,
  commMainNumberDisplay,
  commReplyWindowHours,
  communicationOrgId,
} = require("../config/env");
const { normalizePhoneE164 } = require("../utils/phone");
const { sendTwilioMessage } = require("../outbound/twilioSendMessage");
const { appendEventLog } = require("../dal/appendEventLog");
const { classifyReply } = require("./replyClassifier");
const { getBrandContext } = require("./brandContextService");
const { createMaintenanceTicketFromCommReply } = require("../brain/createMaintenanceTicketFromCommReply");

function normalizeInboundFrom(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.toLowerCase().startsWith("whatsapp:")) {
    return normalizePhoneE164(s.slice("whatsapp:".length));
  }
  return normalizePhoneE164(s);
}

function resolveReplyBrandName(brandContext, propertyCode) {
  const ctx = brandContext && typeof brandContext === "object" ? brandContext : {};
  const short = String(ctx.orgBrandShort || "").trim();
  if (short) return short;
  const full = String(ctx.orgBrandName || "").trim();
  if (full) return full;
  const code = String(propertyCode || "").trim().toUpperCase();
  const prop = ctx.properties && ctx.properties[code];
  if (prop && prop.displayName) return String(prop.displayName).trim();
  return "";
}

/**
 * Auto-response for inbound texts to the broadcast number. The broadcast inbox
 * is not staffed, so every reply professionally redirects the resident to the
 * brand's office and sets the expectation that no human will answer here.
 * `opts.brandName` / `opts.officeNumber` are resolved by the caller; when absent
 * the copy degrades gracefully to generic office wording.
 */
function buildAutoResponse(replyClass, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const brand = String(o.brandName || "").trim();
  const office = String(
    (o.officeNumber !== undefined && o.officeNumber !== null
      ? o.officeNumber
      : commMainNumberDisplay()) || ""
  ).trim();
  const klass = String(replyClass || "").trim().toUpperCase();

  // STOP / opt-out: distinct, compliance-friendly confirmation.
  if (klass === "OPT_OUT") {
    let tail = "";
    if (brand && office) tail = " For assistance, contact " + brand + " at " + office + ".";
    else if (brand) tail = " For assistance, contact " + brand + ".";
    else if (office) tail = " For assistance, call " + office + ".";
    return (
      "You've been unsubscribed and won't receive further notices from this number." + tail
    );
  }

  // Every other inbound reply gets the same unmonitored-inbox redirect.
  if (brand && office) {
    return (
      "This inbox is not monitored. For assistance, please contact " +
      brand +
      "'s office at " +
      office +
      "."
    );
  }
  if (brand) {
    return "This inbox is not monitored. For assistance, please contact " + brand + "'s office.";
  }
  if (office) {
    return (
      "This inbox is not monitored. For assistance, please contact the management office at " +
      office +
      "."
    );
  }
  return "This inbox is not monitored. Please contact your building management office for assistance.";
}

function withinReplyWindow(sentAtIso, windowHours) {
  const sentAt = new Date(String(sentAtIso || ""));
  if (Number.isNaN(sentAt.getTime())) return false;
  const ageMs = Date.now() - sentAt.getTime();
  return ageMs >= 0 && ageMs <= windowHours * 60 * 60 * 1000;
}

async function lookupActiveTenantByPhone(sb, phoneE164) {
  if (!phoneE164) return null;
  const { data, error } = await sb
    .from("tenant_roster")
    .select("id, property_code, unit_label, phone_e164, resident_name, active, updated_at")
    .eq("phone_e164", phoneE164)
    .eq("active", true)
    .order("updated_at", { ascending: false });
  if (error || !data || !data.length) return null;
  const row = data[0];
  return {
    tenantId: String(row.id || "").trim(),
    propertyCode: String(row.property_code || "").trim().toUpperCase(),
    unitLabel: String(row.unit_label || "").trim(),
    residentName: String(row.resident_name || "").trim(),
    phoneE164: String(row.phone_e164 || "").trim(),
  };
}

async function lookupRecentRecipient(sb, phoneE164) {
  if (!phoneE164) return null;
  const { data, error } = await sb
    .from("communication_recipients")
    .select("id, campaign_id, tenant_id, property_code, unit_id, sent_at, status")
    .eq("phone_e164_snapshot", phoneE164)
    .order("sent_at", { ascending: false })
    .limit(10);
  if (error || !data || !data.length) return null;
  const hours = commReplyWindowHours();
  for (const row of data) {
    if (withinReplyWindow(row.sent_at, hours)) {
      return {
        recipientId: String(row.id || "").trim(),
        campaignId: String(row.campaign_id || "").trim(),
        tenantId: String(row.tenant_id || "").trim(),
        propertyCode: String(row.property_code || "").trim().toUpperCase(),
        unitId: String(row.unit_id || "").trim(),
      };
    }
  }
  return null;
}

async function updateBroadcastOptOut(sb, tenantMatch, phoneE164) {
  if (tenantMatch && tenantMatch.tenantId) {
    await sb
      .from("tenant_roster")
      .update({ comm_broadcast_opt_out: true, updated_at: new Date().toISOString() })
      .eq("id", tenantMatch.tenantId);
    return;
  }
  if (phoneE164) {
    await sb
      .from("tenant_roster")
      .update({ comm_broadcast_opt_out: true, updated_at: new Date().toISOString() })
      .eq("phone_e164", phoneE164);
  }
}

async function handleBroadcastReply(input, opts) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const body = input && typeof input === "object" ? input : {};
  const messageSid = String(body.MessageSid || body.SmsSid || body.messageSid || "").trim();
  const messageBody = String(body.Body || body.body || "").trim();
  const phoneE164 = normalizeInboundFrom(body.From || body.from);
  if (!messageSid) return { ok: false, error: "missing_message_sid" };
  if (!phoneE164) return { ok: false, error: "missing_from" };

  const { data: existingReply } = await sb
    .from("communication_replies")
    .select("id")
    .eq("twilio_message_sid", messageSid)
    .maybeSingle();
  if (existingReply && existingReply.id) {
    return { ok: true, deduped: true };
  }

  const tenantMatch = await lookupActiveTenantByPhone(sb, phoneE164);
  const recipientMatch = await lookupRecentRecipient(sb, phoneE164);
  const replyClass = classifyReply(messageBody);

  let handoffCreated = false;
  let ticketSeedId = null;
  if (replyClass === "OPT_OUT") {
    await updateBroadcastOptOut(sb, tenantMatch, phoneE164);
  } else if (replyClass === "MAINTENANCE_SIGNAL" || replyClass === "EMERGENCY_SIGNAL") {
    const handoff = await createMaintenanceTicketFromCommReply({
      phoneE164,
      tenantMatch,
      recipientMatch,
      replyClass,
      messageBody,
      traceId: opts && opts.traceId,
    });
    handoffCreated = handoff && handoff.ok === true;
    ticketSeedId = handoff && handoff.ticketSeedId ? handoff.ticketSeedId : null;
  }

  const propertyCode =
    (tenantMatch && tenantMatch.propertyCode) ||
    (recipientMatch && recipientMatch.propertyCode) ||
    "";
  let brandName = "";
  try {
    const brandContext = await getBrandContext({
      orgId: communicationOrgId(),
      propertyCodes: propertyCode ? [propertyCode] : [],
    });
    brandName = resolveReplyBrandName(brandContext, propertyCode);
  } catch (_) {
    // Brand lookup is best-effort; auto-response degrades to generic copy.
  }
  const autoResponse = buildAutoResponse(replyClass, {
    brandName,
    officeNumber: commMainNumberDisplay(),
  });

  const { data: inserted, error: insertError } = await sb
    .from("communication_replies")
    .insert({
      campaign_id: recipientMatch ? recipientMatch.campaignId : null,
      recipient_id: recipientMatch ? recipientMatch.recipientId : null,
      tenant_id: tenantMatch ? tenantMatch.tenantId : recipientMatch ? recipientMatch.tenantId : null,
      property_code: tenantMatch ? tenantMatch.propertyCode : recipientMatch ? recipientMatch.propertyCode : null,
      unit_id: recipientMatch ? recipientMatch.unitId || null : null,
      phone_from: phoneE164,
      message_body: messageBody,
      reply_class: replyClass,
      twilio_message_sid: messageSid,
      auto_response_sent: autoResponse,
      handoff_created: handoffCreated,
      ticket_seed_id: ticketSeedId,
    })
    .select("id")
    .maybeSingle();
  if (insertError) return { ok: false, error: insertError.message || "reply_insert_failed" };

  const sendResult = await sendTwilioMessage({
    to: phoneE164,
    body: autoResponse,
    traceId: opts && opts.traceId,
    channel: "sms",
    from: twilioBroadcastFrom(),
  });

  await appendEventLog({
    traceId: opts && opts.traceId,
    log_kind: "communication",
    event: "COMM_REPLY_RECEIVED",
    payload: {
      communication_reply_id: inserted && inserted.id ? inserted.id : null,
      campaign_id: recipientMatch ? recipientMatch.campaignId : null,
      recipient_id: recipientMatch ? recipientMatch.recipientId : null,
      tenant_id: tenantMatch ? tenantMatch.tenantId : null,
      reply_class: replyClass,
      handoff_created: handoffCreated,
      auto_response_sent: !!(sendResult && sendResult.ok),
    },
  });

  return {
    ok: true,
    replyClass,
    handoffCreated,
    autoResponseSent: !!(sendResult && sendResult.ok),
  };
}

module.exports = {
  classifyReply,
  buildAutoResponse,
  handleBroadcastReply,
};
