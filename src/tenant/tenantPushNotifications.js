/**
 * Tenant portal Web Push — subscription storage + dispatch.
 * Identity: tenant JWT (roster_id + org_id), not Supabase auth.
 * Table: tenant_push_subscriptions (migration 083).
 *
 * Push events:
 *   rent_due           — reminder before rent is due
 *   rent_late          — rent past due
 *   maintenance_update — ticket status changed
 *   building_notice    — broadcast notice to property
 */

const webpush = require("web-push");
const { getSupabase } = require("../db/supabase");
const {
  portalPushEnabled,
  vapidPublicKey,
  vapidPrivateKey,
  vapidSubject,
} = require("../config/env");

let vapidConfigured = false;

function ensureVapid() {
  if (vapidConfigured) return true;
  if (!portalPushEnabled()) return false;
  const pub = vapidPublicKey();
  const priv = vapidPrivateKey();
  const sub = vapidSubject();
  if (!pub || !priv || !sub) return false;
  webpush.setVapidDetails(sub, pub, priv);
  vapidConfigured = true;
  return true;
}

function normalizeSubscriptionBody(body) {
  const endpoint = String(body?.endpoint || "").trim();
  const keys = body?.keys || {};
  const p256dh = String(keys.p256dh || body?.p256dh || "").trim();
  const authKey = String(keys.auth || body?.auth || body?.auth_key || "").trim();
  if (!endpoint || !p256dh || !authKey) {
    return { ok: false, error: "invalid_push_subscription" };
  }
  return { ok: true, endpoint, p256dh, authKey };
}

/**
 * Upsert a tenant push subscription.
 * Called from the V2 tenant route — tenant is already authenticated via JWT middleware.
 *
 * @param {object} o
 * @param {string} o.tenantId — tenant_roster_id from JWT
 * @param {string} o.orgId
 * @param {string} o.propertyCode
 * @param {object} o.body — raw push subscription JSON from browser
 */
async function upsertTenantPushSubscription(o) {
  if (!ensureVapid()) return { ok: false, error: "portal_push_disabled" };
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "supabase_unavailable" };

  const tenantId = String(o.tenantId || "").trim();
  const orgId = String(o.orgId || "").trim();
  const propertyCode = String(o.propertyCode || "").trim().toUpperCase();
  if (!tenantId || !orgId || !propertyCode) {
    return { ok: false, error: "missing_tenant_context" };
  }

  const parsed = normalizeSubscriptionBody(o.body || {});
  if (!parsed.ok) return parsed;

  const row = {
    org_id: orgId,
    tenant_roster_id: tenantId,
    property_code: propertyCode,
    endpoint: parsed.endpoint,
    p256dh: parsed.p256dh,
    auth_key: parsed.authKey,
    notify_rent_reminders: true,
    notify_maintenance_updates: true,
    notify_building_notices: true,
    active: true,
    updated_at: new Date().toISOString(),
  };

  const { error } = await sb
    .from("tenant_push_subscriptions")
    .upsert(row, { onConflict: "tenant_roster_id,endpoint" });

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Deactivate a tenant push subscription by endpoint.
 */
async function deactivateTenantPushSubscription(o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "supabase_unavailable" };

  const tenantId = String(o.tenantId || "").trim();
  const endpoint = String(o.endpoint || o.body?.endpoint || "").trim();
  if (!tenantId || !endpoint) return { ok: false, error: "missing_fields" };

  const { error } = await sb
    .from("tenant_push_subscriptions")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("tenant_roster_id", tenantId)
    .eq("endpoint", endpoint);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

async function deactivateSubscriptionById(sb, id) {
  if (!sb || !id) return;
  await sb
    .from("tenant_push_subscriptions")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("id", id);
}

/**
 * Send a push notification to a single subscription row.
 */
async function sendPushToRow(sb, row, payload) {
  if (!ensureVapid()) return { ok: false, skipped: true };
  try {
    await webpush.sendNotification(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth_key } },
      JSON.stringify(payload)
    );
    return { ok: true };
  } catch (err) {
    const status = err && typeof err.statusCode === "number" ? err.statusCode : 0;
    if (status === 404 || status === 410) {
      await deactivateSubscriptionById(sb, row.id);
    }
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Dispatch a push notification to all active tenant subscriptions for a property.
 *
 * @param {object} o
 * @param {string} o.propertyCode
 * @param {string} [o.tenantRosterId]   — if set, send only to this tenant
 * @param {string} o.eventType          — rent_due | rent_late | maintenance_update | building_notice
 * @param {string} o.title
 * @param {string} o.body
 * @param {string} [o.url]              — deep link opened on notification tap
 * @param {string} [o.tag]
 */
async function dispatchTenantPush(o) {
  if (!ensureVapid()) return { ok: false, skipped: true, reason: "portal_push_disabled" };
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "supabase_unavailable" };

  const propertyCode = String(o.propertyCode || "").trim().toUpperCase();
  const title = String(o.title || "").trim();
  const body = String(o.body || "").trim();
  const url = String(o.url || "/tenant/dashboard").trim() || "/tenant/dashboard";
  const eventType = String(o.eventType || "").trim();
  if (!propertyCode || !title || !eventType) {
    return { ok: false, error: "missing_push_fields" };
  }

  const prefCol = {
    rent_due: "notify_rent_reminders",
    rent_late: "notify_rent_reminders",
    maintenance_update: "notify_maintenance_updates",
    building_notice: "notify_building_notices",
  }[eventType] || "notify_building_notices";

  let query = sb
    .from("tenant_push_subscriptions")
    .select("id, endpoint, p256dh, auth_key")
    .eq("property_code", propertyCode)
    .eq("active", true)
    .eq(prefCol, true);

  if (o.tenantRosterId) {
    query = query.eq("tenant_roster_id", o.tenantRosterId);
  }

  const { data: rows, error } = await query;
  if (error) return { ok: false, error: error.message };
  if (!rows?.length) return { ok: true, sent: 0, skipped: true };

  const payload = {
    title,
    body,
    url,
    tag: String(o.tag || eventType).trim() || eventType,
    icon: "/api/tenant/pwa-icon/192?v=4",
  };

  let sent = 0;
  for (const row of rows) {
    const r = await sendPushToRow(sb, row, payload);
    if (r.ok) sent++;
  }
  return { ok: true, sent };
}

async function notifyTenantRentDue(o) {
  const unitLabel = String(o.unitLabel || "").trim();
  const amountStr = o.amountCents ? `$${(o.amountCents / 100).toFixed(2)}` : "";
  const body = [
    amountStr || "Rent payment",
    unitLabel ? `Unit ${unitLabel}` : null,
    "is due soon.",
  ].filter(Boolean).join(" · ");
  return dispatchTenantPush({
    propertyCode: o.propertyCode,
    tenantRosterId: o.tenantRosterId,
    eventType: "rent_due",
    title: "Rent reminder",
    body,
    url: "/tenant/balance",
    tag: `rent-due-${o.propertyCode}-${unitLabel}`,
  });
}

async function notifyTenantRentLate(o) {
  const unitLabel = String(o.unitLabel || "").trim();
  const amountStr = o.amountCents ? `$${(o.amountCents / 100).toFixed(2)}` : "";
  const body = [
    amountStr || "Rent",
    unitLabel ? `Unit ${unitLabel}` : null,
    "is past due.",
  ].filter(Boolean).join(" · ");
  return dispatchTenantPush({
    propertyCode: o.propertyCode,
    tenantRosterId: o.tenantRosterId,
    eventType: "rent_late",
    title: "Rent past due",
    body,
    url: "/tenant/balance",
    tag: `rent-late-${o.propertyCode}-${unitLabel}`,
  });
}

async function notifyTenantMaintenanceUpdate(o) {
  const ticketId = String(o.ticketId || "").trim();
  const status = String(o.status || "updated").trim();
  const issue = String(o.issue || "Your maintenance request").trim();
  return dispatchTenantPush({
    propertyCode: o.propertyCode,
    tenantRosterId: o.tenantRosterId,
    eventType: "maintenance_update",
    title: "Maintenance update",
    body: `${issue} — ${status}`,
    url: ticketId ? `/tenant/maintenance/${ticketId}` : "/tenant/maintenance",
    tag: ticketId ? `maint-${ticketId}` : "maintenance-update",
  });
}

async function notifyTenantBuildingNotice(o) {
  const title = String(o.title || "Building notice").trim();
  const body = String(o.body || "A new notice from your building.").trim();
  return dispatchTenantPush({
    propertyCode: o.propertyCode,
    eventType: "building_notice",
    title,
    body,
    url: "/tenant/notices",
    tag: o.noticeId ? `notice-${o.noticeId}` : "building-notice",
  });
}

module.exports = {
  upsertTenantPushSubscription,
  deactivateTenantPushSubscription,
  dispatchTenantPush,
  notifyTenantRentDue,
  notifyTenantRentLate,
  notifyTenantMaintenanceUpdate,
  notifyTenantBuildingNotice,
};
