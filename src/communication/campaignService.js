const { getSupabase } = require("../db/supabase");
const { communicationOrgId } = require("../config/env");
const { appendEventLog } = require("../dal/appendEventLog");
const { draftMessage, appendFooter, estimateSmsSegments } = require("./messageComposer");
const { sendCampaign } = require("./commOutgate");
const {
  normalizeAudienceKind,
  normalizeAudienceFilter,
  getAudiencePreview,
} = require("./audienceResolver");
const { getBrandContext } = require("./brandContextService");

const COMM_TYPES = new Set([
  "BUILDING_UPDATE",
  "MAINTENANCE_NOTICE",
  "POLICY_REMINDER",
  "EMERGENCY_ALERT",
  "LEASE_ADMIN",
]);

const COMM_STATUSES = new Set([
  "DRAFT",
  "QUEUED",
  "SENDING",
  "SENT",
  "PARTIALLY_SENT",
  "FAILED",
  "CANCELLED",
]);

const CAMPAIGN_SELECT =
  "id, org_id, title, comm_type, status, audience_kind, audience_filter, audience_snapshot, message_body, comm_type_key, ai_assisted, agent_initiated, tone, language, scheduled_at, sent_at, created_by, total_recipients, total_sent, total_delivered, total_failed, created_at, updated_at";
const CAMPAIGN_RECIPIENT_DETAIL_LIMIT = 200;
const CAMPAIGN_REPLY_DETAIL_LIMIT = 100;

function normalizeCommType(raw) {
  const value = String(raw || "").trim().toUpperCase();
  return COMM_TYPES.has(value) ? value : "";
}

function normalizeCommStatus(raw) {
  const value = String(raw || "").trim().toUpperCase();
  return COMM_STATUSES.has(value) ? value : "";
}

function normalizeLanguage(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return value || "en";
}

function normalizeTone(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return value || "professional";
}

function normalizeDraftBody(raw) {
  return String(raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizePositiveInt(raw, fallback, maxValue) {
  const n = parseInt(String(raw == null ? "" : raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, maxValue);
}

function buildAudienceSnapshot(recipients) {
  return (Array.isArray(recipients) ? recipients : []).map((row) => ({
    tenantId: row.tenantId || "",
    unitId: row.unitId || "",
    propertyCode: row.propertyCode || "",
    displayName: row.displayName || "",
    unitLabel: row.unitLabel || "",
    name: row.name || "",
    phone: row.phone || "",
    channel: row.channel || "sms",
    skipReason: row.skipReason || "",
  }));
}

function countRecipientStatuses(rows) {
  let totalRecipients = 0;
  let totalSendable = 0;
  let totalFailed = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    totalRecipients += 1;
    const status = String(row.status || "").trim().toUpperCase();
    if (status === "PENDING" || status === "QUEUED" || status === "SENT" || status === "DELIVERED") {
      totalSendable += 1;
    }
    if (status === "FAILED") totalFailed += 1;
  }
  return { totalRecipients, totalSendable, totalFailed };
}

function isPortalOnlyDelivery(audienceFilter) {
  const f = audienceFilter && typeof audienceFilter === "object" ? audienceFilter : {};
  return String(f.delivery_mode || "").trim().toLowerCase() === "portal_only";
}

function mapCampaignRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    orgId: String(row.org_id || "").trim(),
    title: String(row.title || "").trim(),
    commType: String(row.comm_type || "").trim(),
    status: String(row.status || "").trim(),
    audienceKind: String(row.audience_kind || "").trim(),
    audienceFilter:
      row.audience_filter && typeof row.audience_filter === "object"
        ? row.audience_filter
        : {},
    audienceSnapshot:
      row.audience_snapshot && typeof row.audience_snapshot === "object"
        ? row.audience_snapshot
        : null,
    messageBody: String(row.message_body || "").trim(),
    commTypeKey: String(row.comm_type_key || "").trim(),
    aiAssisted: row.ai_assisted === true,
    agentInitiated: row.agent_initiated === true,
    tone: normalizeTone(row.tone),
    language: normalizeLanguage(row.language),
    scheduledAt: row.scheduled_at || null,
    sentAt: row.sent_at || null,
    createdBy: String(row.created_by || "").trim(),
    totalRecipients: Number(row.total_recipients || 0),
    totalSent: Number(row.total_sent || 0),
    totalDelivered: Number(row.total_delivered || 0),
    totalFailed: Number(row.total_failed || 0),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapRecipientDetailRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id || "",
    propertyCode: String(row.property_code || "").trim().toUpperCase(),
    unitId: row.unit_id || "",
    unitLabel: String(row.unit_label_snapshot || "").trim(),
    tenantName: String(row.tenant_name_snapshot || "").trim(),
    phone: String(row.phone_e164_snapshot || "").trim(),
    channel: String(row.channel || "sms").trim() || "sms",
    status: String(row.status || "").trim(),
    twilioMessageSid: String(row.twilio_message_sid || "").trim(),
    errorCode: String(row.error_code || "").trim(),
    errorMessage: String(row.error_message || "").trim(),
    queuedAt: row.queued_at || null,
    sentAt: row.sent_at || null,
    deliveredAt: row.delivered_at || null,
    failedAt: row.failed_at || null,
    createdAt: row.created_at || null,
  };
}

function mapReplyDetailRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    campaignId: row.campaign_id || null,
    recipientId: row.recipient_id || null,
    tenantId: row.tenant_id || null,
    propertyCode: String(row.property_code || "").trim().toUpperCase(),
    unitId: row.unit_id || null,
    phoneFrom: String(row.phone_from || "").trim(),
    messageBody: String(row.message_body || "").trim(),
    replyClass: String(row.reply_class || "").trim(),
    twilioMessageSid: String(row.twilio_message_sid || "").trim(),
    autoResponseSent: String(row.auto_response_sent || "").trim(),
    handoffCreated: row.handoff_created === true,
    ticketSeedId: row.ticket_seed_id || null,
    receivedAt: row.received_at || null,
    createdAt: row.created_at || null,
  };
}

async function fetchCampaignRow(sb, id) {
  const rid = String(id || "").trim();
  if (!rid) return { ok: false, error: "missing_campaign_id" };
  const { data, error } = await sb
    .from("communication_campaigns")
    .select(CAMPAIGN_SELECT)
    .eq("id", rid)
    .maybeSingle();
  if (error) return { ok: false, error: error.message || "campaign_lookup_failed" };
  if (!data) return { ok: false, error: "not_found" };
  return { ok: true, row: data };
}

async function updateCampaignDraft(input, opts) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const body = input && typeof input === "object" ? input : {};
  const campaignId = String(body.campaignId || body.campaign_id || "").trim();
  if (!campaignId) return { ok: false, error: "missing_campaign_id" };

  const campaignOut = await fetchCampaignRow(sb, campaignId);
  if (!campaignOut.ok) return campaignOut;
  if (String(campaignOut.row.status || "").trim().toUpperCase() !== "DRAFT") {
    return { ok: false, error: "campaign_not_draft" };
  }

  const brief = String(body.brief || "").trim();
  const manualBody = normalizeDraftBody(body.messageBody || body.message_body || "");
  if (!brief && !manualBody) return { ok: false, error: "missing_draft_input" };

  const brandContext = await getBrandContext({
    orgId: campaignOut.row.org_id,
    propertyCodes: Array.isArray(campaignOut.row.audience_filter && campaignOut.row.audience_filter.property_codes)
      ? campaignOut.row.audience_filter.property_codes
      : [],
  });
  const audienceLabelPreview = await getAudiencePreview({
    sb,
    orgId: campaignOut.row.org_id,
    audienceKind: campaignOut.row.audience_kind,
    audienceFilter: campaignOut.row.audience_filter,
    brandContext,
  });
  if (!audienceLabelPreview.ok) return audienceLabelPreview;

  const nextTone =
    String(body.tone || campaignOut.row.tone || "professional").trim().toLowerCase() || "professional";
  const nextLanguage =
    String(body.language || campaignOut.row.language || "en").trim().toLowerCase() || "en";

  let drafted = null;
  let nextMessageBody = manualBody;
  let nextAiAssisted =
    body.aiAssisted === true ||
    body.ai_assisted === true ||
    campaignOut.row.ai_assisted === true;
  let event = "COMM_DRAFT_SAVED";

  if (!nextMessageBody) {
    drafted = await draftMessage({
      brief,
      commType: campaignOut.row.comm_type,
      tone: nextTone,
      language: nextLanguage,
      brandContext,
      audienceLabel: audienceLabelPreview.audienceLabel,
      deliveryMode:
        campaignOut.row.audience_filter &&
        typeof campaignOut.row.audience_filter === "object"
          ? campaignOut.row.audience_filter.delivery_mode
          : "",
    });
    if (!drafted.ok) return drafted;
    nextMessageBody = normalizeDraftBody(drafted.body);
    nextAiAssisted = drafted.aiAssisted === true;
    event = "COMM_DRAFT_GENERATED";
  } else if (body.aiAssisted === true || body.ai_assisted === true) {
    nextAiAssisted = true;
  }

  const patch = {
    message_body: nextMessageBody,
    ai_assisted: nextAiAssisted === true,
    tone: nextTone,
    language: nextLanguage,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await sb
    .from("communication_campaigns")
    .update(patch)
    .eq("id", campaignId)
    .select(CAMPAIGN_SELECT)
    .maybeSingle();
  if (error) return { ok: false, error: error.message || "campaign_draft_update_failed" };
  if (!data) return { ok: false, error: "campaign_draft_update_failed" };

  await appendEventLog({
    traceId: opts && opts.traceId,
    log_kind: "communication",
    event,
    payload: {
      campaign_id: campaignId,
      ai_assisted: patch.ai_assisted === true,
      manual_body: !!manualBody,
    },
  });

  return {
    ok: true,
    campaign: mapCampaignRow(data),
    draft: {
      body: nextMessageBody,
      aiAssisted: patch.ai_assisted === true,
      audienceLabel: audienceLabelPreview.audienceLabel,
      warning: drafted && drafted.warning ? drafted.warning : "",
    },
  };
}

async function createCampaign(input, opts) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const body = input && typeof input === "object" ? input : {};
  const title = String(body.title || "").trim();
  if (!title) return { ok: false, error: "missing_title" };

  const commType = normalizeCommType(body.commType || body.comm_type);
  if (!commType) return { ok: false, error: "invalid_comm_type" };

  const audienceKind = normalizeAudienceKind(body.audienceKind || body.audience_kind);
  if (!audienceKind) return { ok: false, error: "invalid_audience_kind" };

  const orgId = String(body.orgId || body.org_id || communicationOrgId()).trim() || "grand";
  const audienceFilter = normalizeAudienceFilter(body.audienceFilter || body.audience_filter);
  const messageBody = String(body.messageBody || body.message_body || "").trim();
  const tone = normalizeTone(body.tone);
  const language = normalizeLanguage(body.language);
  const createdBy = String(body.createdBy || body.created_by || "PORTAL").trim() || "PORTAL";
  const commTypeKey =
    String(body.commTypeKey || body.comm_type_key || commType).trim() || commType;

  const insertRow = {
    org_id: orgId,
    title,
    comm_type: commType,
    audience_kind: audienceKind,
    audience_filter: audienceFilter,
    message_body: messageBody,
    comm_type_key: commTypeKey,
    ai_assisted: body.aiAssisted === true || body.ai_assisted === true,
    agent_initiated: body.agentInitiated === true || body.agent_initiated === true,
    tone,
    language,
    created_by: createdBy,
  };

  const scheduledAtRaw = String(body.scheduledAt || body.scheduled_at || "").trim();
  if (scheduledAtRaw) {
    const parsed = new Date(scheduledAtRaw);
    if (!Number.isNaN(parsed.getTime())) {
      insertRow.scheduled_at = parsed.toISOString();
    }
  }

  const { data, error } = await sb
    .from("communication_campaigns")
    .insert(insertRow)
    .select(CAMPAIGN_SELECT)
    .maybeSingle();
  if (error) return { ok: false, error: error.message || "campaign_create_failed" };
  if (!data) return { ok: false, error: "campaign_create_failed" };

  await appendEventLog({
    traceId: opts && opts.traceId,
    log_kind: "communication",
    event: "COMM_CAMPAIGN_CREATED",
    payload: {
      campaign_id: data.id,
      comm_type: data.comm_type,
      audience_kind: data.audience_kind,
      created_by: data.created_by,
      agent_initiated: data.agent_initiated === true,
    },
  });

  return { ok: true, campaign: mapCampaignRow(data) };
}

async function listCampaigns(input) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db", campaigns: [] };

  const opts = input && typeof input === "object" ? input : {};
  const status = normalizeCommStatus(opts.status);
  const limit = normalizePositiveInt(opts.limit, 50, 200) || 50;
  const offset = normalizePositiveInt(opts.offset, 0, 10000) || 0;
  const orgId = String(opts.orgId || opts.org_id || communicationOrgId()).trim() || "grand";

  let query = sb
    .from("communication_campaigns")
    .select(CAMPAIGN_SELECT)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) return { ok: false, error: error.message || "campaign_list_failed", campaigns: [] };

  return {
    ok: true,
    campaigns: (data || []).map(mapCampaignRow),
    limit,
    offset,
  };
}

async function getCampaignDetail(id) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const campaignOut = await fetchCampaignRow(sb, id);
  if (!campaignOut.ok) return campaignOut;

  const { data: recipientRows, error: recipientError } = await sb
    .from("communication_recipients")
    .select("status, property_code")
    .eq("campaign_id", String(id || "").trim());
  if (recipientError) {
    return { ok: false, error: recipientError.message || "recipient_summary_failed" };
  }

  const { count: replyCount, error: replyError } = await sb
    .from("communication_replies")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", String(id || "").trim());
  if (replyError) {
    return { ok: false, error: replyError.message || "reply_summary_failed" };
  }

  const { data: recipientDetailRows, error: recipientDetailError } = await sb
    .from("communication_recipients")
    .select(
      "id, tenant_id, property_code, unit_id, unit_label_snapshot, tenant_name_snapshot, phone_e164_snapshot, channel, status, twilio_message_sid, error_code, error_message, queued_at, sent_at, delivered_at, failed_at, created_at"
    )
    .eq("campaign_id", String(id || "").trim())
    .order("property_code", { ascending: true })
    .order("unit_label_snapshot", { ascending: true })
    .order("tenant_name_snapshot", { ascending: true })
    .limit(CAMPAIGN_RECIPIENT_DETAIL_LIMIT);
  if (recipientDetailError) {
    return { ok: false, error: recipientDetailError.message || "recipient_detail_failed" };
  }

  const { data: replyRows, error: replyDetailError } = await sb
    .from("communication_replies")
    .select(
      "id, campaign_id, recipient_id, tenant_id, property_code, unit_id, phone_from, message_body, reply_class, twilio_message_sid, auto_response_sent, handoff_created, ticket_seed_id, received_at, created_at"
    )
    .eq("campaign_id", String(id || "").trim())
    .order("received_at", { ascending: false })
    .limit(CAMPAIGN_REPLY_DETAIL_LIMIT);
  if (replyDetailError) {
    return { ok: false, error: replyDetailError.message || "reply_detail_failed" };
  }

  const recipientStatusCounts = {};
  const byProperty = {};
  for (const row of recipientRows || []) {
    const status = String(row.status || "").trim() || "UNKNOWN";
    recipientStatusCounts[status] = (recipientStatusCounts[status] || 0) + 1;
    const propertyCode = String(row.property_code || "").trim().toUpperCase();
    if (propertyCode) byProperty[propertyCode] = (byProperty[propertyCode] || 0) + 1;
  }

  return {
    ok: true,
    campaign: mapCampaignRow(campaignOut.row),
    summary: {
      recipientStatusCounts,
      byProperty,
      replyCount: Number(replyCount || 0),
    },
    recipients: (recipientDetailRows || []).map(mapRecipientDetailRow).filter(Boolean),
    replies: (replyRows || []).map(mapReplyDetailRow).filter(Boolean),
    detailLimits: {
      recipients: CAMPAIGN_RECIPIENT_DETAIL_LIMIT,
      replies: CAMPAIGN_REPLY_DETAIL_LIMIT,
    },
  };
}

async function deleteCampaign(id, opts) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const campaignOut = await fetchCampaignRow(sb, id);
  if (!campaignOut.ok) return campaignOut;

  const row = campaignOut.row;
  const status = String(row.status || "").trim().toUpperCase();
  const canDelete = status === "DRAFT" || status === "QUEUED" || status === "FAILED";
  if (!canDelete) {
    return { ok: false, error: "campaign_not_deletable" };
  }

  const { data, error } = await sb
    .from("communication_campaigns")
    .delete()
    .eq("id", String(id || "").trim())
    .select("id, title, status")
    .maybeSingle();
  if (error) return { ok: false, error: error.message || "campaign_delete_failed" };
  if (!data) return { ok: false, error: "campaign_delete_failed" };

  await appendEventLog({
    traceId: opts && opts.traceId,
    log_kind: "communication",
    event: "COMM_CAMPAIGN_DELETED",
    payload: {
      campaign_id: data.id,
      title: String(data.title || "").trim(),
      status: String(data.status || "").trim(),
    },
  });

  return {
    ok: true,
    deleted: {
      id: data.id,
      title: String(data.title || "").trim(),
      status: String(data.status || "").trim(),
    },
  };
}

async function resolveCampaignAudiencePreview(id, opts) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const campaignOut = await fetchCampaignRow(sb, id);
  if (!campaignOut.ok) return campaignOut;
  const row = campaignOut.row;

  const preview = await getAudiencePreview({
    sb,
    orgId: row.org_id,
    audienceKind: row.audience_kind,
    audienceFilter: row.audience_filter,
  });
  if (!preview.ok) return preview;

  await appendEventLog({
    traceId: opts && opts.traceId,
    log_kind: "communication",
    event: "COMM_AUDIENCE_RESOLVED",
    payload: {
      campaign_id: row.id,
      total: preview.total,
      will_send: preview.willSend,
      skipped_no_phone: preview.skippedNoPhone,
      skipped_opt_out: preview.skippedOptOut,
      skipped_no_unit: preview.skippedNoUnit,
    },
  });

  return {
    ok: true,
    campaign: mapCampaignRow(row),
    preview: {
      audienceLabel: preview.audienceLabel,
      total: preview.total,
      willSend: preview.willSend,
      skippedNoPhone: preview.skippedNoPhone,
      skippedOptOut: preview.skippedOptOut,
      skippedNoUnit: preview.skippedNoUnit,
      byProperty: preview.byProperty,
      recipientsSample: preview.recipients.slice(0, 100),
    },
  };
}

async function previewCampaignMessage(id, input) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const campaignOut = await fetchCampaignRow(sb, id);
  if (!campaignOut.ok) return campaignOut;
  const row = campaignOut.row;
  const body = input && typeof input === "object" ? input : {};

  const draftBody = normalizeDraftBody(body.messageBody || body.message_body || row.message_body || "");
  if (!draftBody) return { ok: false, error: "missing_message_body" };

  const audienceFilter =
    row.audience_filter && typeof row.audience_filter === "object" ? row.audience_filter : {};
  const propertyCodes = Array.isArray(audienceFilter.property_codes)
    ? audienceFilter.property_codes
        .map((code) => String(code || "").trim().toUpperCase())
        .filter(Boolean)
    : [];
  const isMultiProperty =
    String(row.audience_kind || "").trim().toUpperCase() === "PORTFOLIO" || propertyCodes.length !== 1;
  const previewPropertyCode = !isMultiProperty && propertyCodes.length === 1 ? propertyCodes[0] : "";
  const language =
    String(body.language || row.language || "en").trim().toLowerCase() || "en";

  const brandContext = await getBrandContext({
    orgId: row.org_id,
    propertyCodes,
  });
  const audienceLabelPreview = await getAudiencePreview({
    sb,
    orgId: row.org_id,
    audienceKind: row.audience_kind,
    audienceFilter,
    brandContext,
  });
  if (!audienceLabelPreview.ok) return audienceLabelPreview;

  const finalBody = appendFooter(draftBody, brandContext, previewPropertyCode, "", language, {
    isMultiProperty,
  });
  const smsEstimate = estimateSmsSegments(finalBody);

  return {
    ok: true,
    campaign: mapCampaignRow(row),
    previewMessage: {
      body: finalBody,
      baseBody: draftBody,
      audienceLabel: audienceLabelPreview.audienceLabel,
      smsEstimate,
    },
  };
}

async function prepareCampaign(id, opts) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const campaignOut = await fetchCampaignRow(sb, id);
  if (!campaignOut.ok) return campaignOut;
  const row = campaignOut.row;
  const status = String(row.status || "").trim().toUpperCase();
  if (status !== "DRAFT" && status !== "QUEUED") {
    return { ok: false, error: "campaign_not_preparable" };
  }
  if (!String(row.message_body || "").trim()) {
    return { ok: false, error: "missing_message_body" };
  }

  const preview = await getAudiencePreview({
    sb,
    orgId: row.org_id,
    audienceKind: row.audience_kind,
    audienceFilter: row.audience_filter,
  });
  if (!preview.ok) return preview;
  if (!preview.willSend) {
    return { ok: false, error: "no_sendable_recipients" };
  }
  const portalOnlyDelivery = isPortalOnlyDelivery(row.audience_filter);

  await sb.from("communication_recipients").delete().eq("campaign_id", String(id || "").trim());

  const inserts = preview.recipients.map((recipient) => {
    const skipReason = String(recipient.skipReason || "").trim().toUpperCase();
    const nowIso = new Date().toISOString();
    const portalOnlySendable = portalOnlyDelivery && !skipReason;
    return {
      campaign_id: row.id,
      tenant_id: recipient.tenantId,
      property_code: recipient.propertyCode,
      unit_id: recipient.unitId,
      unit_label_snapshot: recipient.unitLabel,
      tenant_name_snapshot: recipient.name,
      phone_e164_snapshot: recipient.phone,
      channel: portalOnlySendable ? "portal" : recipient.channel,
      status:
        skipReason === "NO_PHONE"
          ? "SKIPPED_NO_PHONE"
          : skipReason === "OPT_OUT"
            ? "SKIPPED_OPT_OUT"
            : portalOnlySendable
              ? "DELIVERED"
              : "PENDING",
      queued_at: skipReason ? null : nowIso,
      sent_at: portalOnlySendable ? nowIso : null,
      delivered_at: portalOnlySendable ? nowIso : null,
    };
  });

  const { data: insertedRows, error: insertError } = await sb
    .from("communication_recipients")
    .insert(inserts)
    .select("status");
  if (insertError) {
    return { ok: false, error: insertError.message || "recipient_insert_failed" };
  }

  const counts = countRecipientStatuses(insertedRows || []);
  const campaignStatus = portalOnlyDelivery ? "SENT" : "QUEUED";
  const sentAt = portalOnlyDelivery ? new Date().toISOString() : null;
  const { data, error } = await sb
    .from("communication_campaigns")
    .update({
      audience_snapshot: buildAudienceSnapshot(preview.recipients),
      total_recipients: counts.totalRecipients,
      total_sent: portalOnlyDelivery ? counts.totalSendable : 0,
      total_delivered: portalOnlyDelivery ? counts.totalSendable : 0,
      total_failed: 0,
      status: campaignStatus,
      sent_at: sentAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .select(CAMPAIGN_SELECT)
    .maybeSingle();
  if (error) return { ok: false, error: error.message || "campaign_prepare_failed" };
  if (!data) return { ok: false, error: "campaign_prepare_failed" };

  await appendEventLog({
    traceId: opts && opts.traceId,
    log_kind: "communication",
    event: "COMM_CAMPAIGN_PREPARED",
    payload: {
      campaign_id: row.id,
      total_recipients: counts.totalRecipients,
      will_send: preview.willSend,
      skipped_no_phone: preview.skippedNoPhone,
      skipped_opt_out: preview.skippedOptOut,
      skipped_no_unit: preview.skippedNoUnit,
      delivery_mode: portalOnlyDelivery ? "portal_only" : "sms_and_portal",
    },
  });

  return {
    ok: true,
    campaign: mapCampaignRow(data),
    preview: {
      audienceLabel: preview.audienceLabel,
      total: preview.total,
      willSend: preview.willSend,
      skippedNoPhone: preview.skippedNoPhone,
      skippedOptOut: preview.skippedOptOut,
      skippedNoUnit: preview.skippedNoUnit,
      byProperty: preview.byProperty,
      deliveryMode: portalOnlyDelivery ? "portal_only" : "sms_and_portal",
    },
  };
}

async function sendCampaignNow(id, opts) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  let campaignOut = await fetchCampaignRow(sb, id);
  if (!campaignOut.ok) return campaignOut;
  let row = campaignOut.row;
  let status = String(row.status || "").trim().toUpperCase();

  if (status === "DRAFT") {
    const prepared = await prepareCampaign(id, opts);
    if (!prepared.ok) return prepared;
    campaignOut = await fetchCampaignRow(sb, id);
    if (!campaignOut.ok) return campaignOut;
    row = campaignOut.row;
    status = String(row.status || "").trim().toUpperCase();
    if (status === "SENT") {
      return {
        ok: true,
        campaign: mapCampaignRow(row),
        send: { status: "SENT", sent: Number(row.total_sent || 0), failed: Number(row.total_failed || 0) },
      };
    }
  }

  if (status !== "QUEUED" && status !== "SENDING") {
    return { ok: false, error: "campaign_not_sendable" };
  }

  const sent = await sendCampaign({ campaign: row, traceId: opts && opts.traceId });
  if (!sent.ok) return sent;

  campaignOut = await fetchCampaignRow(sb, id);
  if (!campaignOut.ok) return campaignOut;

  return {
    ok: true,
    campaign: mapCampaignRow(campaignOut.row),
    send: {
      status: sent.status,
      sent: sent.sent,
      failed: sent.failed,
    },
  };
}

module.exports = {
  COMM_TYPES,
  COMM_STATUSES,
  mapCampaignRow,
  createCampaign,
  listCampaigns,
  getCampaignDetail,
  deleteCampaign,
  updateCampaignDraft,
  resolveCampaignAudiencePreview,
  previewCampaignMessage,
  prepareCampaign,
  sendCampaignNow,
};
