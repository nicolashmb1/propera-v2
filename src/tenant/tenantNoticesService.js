/**
 * Tenant portal — communication campaign notices (resident-safe read model).
 */
const { applyDisplayToTenantNotice, applyDisplayToTenantNotices } = require("./tenantDisplayI18n");

function tenantCtxScope(tenantCtx) {
  return {
    tenantId: String(tenantCtx?.tenantId || "").trim(),
    propertyCode: String(tenantCtx?.propertyCode || "").trim().toUpperCase(),
  };
}

function isTenantPortalNoticeEnabled(audienceFilter) {
  const f = audienceFilter && typeof audienceFilter === "object" ? audienceFilter : {};
  // Default true so existing campaigns are visible unless explicitly disabled.
  if (Object.prototype.hasOwnProperty.call(f, "include_tenant_portal")) {
    return f.include_tenant_portal !== false;
  }
  return true;
}

function mapNoticeRow(row) {
  const campaign = row?.communication_campaigns || {};
  return {
    id: String(row.id || "").trim(),
    campaignId: String(row.campaign_id || "").trim(),
    title: String(campaign.title || "").trim() || "Building notice",
    commType: String(campaign.comm_type || "").trim() || "BUILDING_UPDATE",
    messageBody: String(campaign.message_body || "").trim(),
    status: String(row.status || "").trim(),
    sentAt: row.sent_at || campaign.sent_at || null,
    deliveredAt: row.delivered_at || null,
    openedAt: row.opened_at || null,
    createdAt: row.created_at || null,
  };
}

async function listTenantNotices(sb, tenantCtx, opts = {}) {
  const scope = tenantCtxScope(tenantCtx);
  if (!scope.tenantId || !scope.propertyCode) return [];
  const limit = Math.min(Math.max(Number(opts.limit || 20), 1), 100);
  const offset = Math.max(Number(opts.offset || 0), 0);

  const { data, error } = await sb
    .from("communication_recipients")
    .select(
      "id, campaign_id, property_code, status, sent_at, delivered_at, opened_at, created_at, " +
        "communication_campaigns:campaign_id(id, title, comm_type, message_body, sent_at, status, audience_filter)"
    )
    .eq("tenant_id", scope.tenantId)
    .eq("property_code", scope.propertyCode)
    .in("status", ["SENT", "DELIVERED"])
    .order("sent_at", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw Object.assign(new Error(error.message), { code: "DB_ERROR" });

  const mapped = (data || [])
    .filter((row) => row?.communication_campaigns)
    .filter((row) => isTenantPortalNoticeEnabled(row.communication_campaigns.audience_filter))
    .map(mapNoticeRow);
  return applyDisplayToTenantNotices(mapped, tenantCtx.preferredLanguage);
}

async function getTenantNotice(sb, tenantCtx, recipientId) {
  const scope = tenantCtxScope(tenantCtx);
  const id = String(recipientId || "").trim();
  if (!scope.tenantId || !scope.propertyCode || !id) return null;

  const { data, error } = await sb
    .from("communication_recipients")
    .select(
      "id, campaign_id, tenant_id, property_code, status, sent_at, delivered_at, opened_at, created_at, " +
        "communication_campaigns:campaign_id(id, title, comm_type, message_body, sent_at, status, audience_filter)"
    )
    .eq("id", id)
    .eq("tenant_id", scope.tenantId)
    .eq("property_code", scope.propertyCode)
    .in("status", ["SENT", "DELIVERED"])
    .maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { code: "DB_ERROR" });
  if (!data || !data.communication_campaigns) return null;
  if (!isTenantPortalNoticeEnabled(data.communication_campaigns.audience_filter)) return null;

  if (!data.opened_at) {
    const nowIso = new Date().toISOString();
    const { error: upErr } = await sb
      .from("communication_recipients")
      .update({ opened_at: nowIso })
      .eq("id", id)
      .eq("tenant_id", scope.tenantId);
    if (!upErr) data.opened_at = nowIso;
  }

  const notice = mapNoticeRow(data);
  return applyDisplayToTenantNotice(notice, tenantCtx.preferredLanguage);
}

module.exports = {
  listTenantNotices,
  getTenantNotice,
};

