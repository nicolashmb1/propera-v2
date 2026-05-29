/**
 * Staff portal Web Push — subscription storage + dispatch (V2 brain).
 * Opt-in via propera-app; fires on new tickets and amenity reservations.
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

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} accessToken
 */
async function resolvePortalAuthUserFromJwt(sb, accessToken) {
  const tok = String(accessToken || "").trim();
  if (!tok) return { ok: false, error: "missing_portal_access_token" };

  const { data: userData, error: authErr } = await sb.auth.getUser(tok);
  if (authErr || !userData?.user) {
    return { ok: false, error: "invalid_portal_access_token" };
  }

  const user = userData.user;
  const authUserId = String(user.id || "").trim();
  const emailLower = user.email ? String(user.email).trim().toLowerCase() : "";
  if (!authUserId) return { ok: false, error: "missing_auth_user_id" };

  let allow = null;
  const { data: byUid } = await sb
    .from("portal_auth_allowlist")
    .select("active, email_lower, auth_user_id")
    .eq("auth_user_id", authUserId)
    .eq("active", true)
    .maybeSingle();
  if (byUid) allow = byUid;

  if (!allow && emailLower) {
    const { data: byEmail } = await sb
      .from("portal_auth_allowlist")
      .select("active, email_lower, auth_user_id")
      .eq("email_lower", emailLower)
      .eq("active", true)
      .maybeSingle();
    if (byEmail) allow = byEmail;
  }

  if (!allow) return { ok: false, error: "portal_user_not_allowlisted" };

  return {
    ok: true,
    authUserId,
    emailLower: String(allow.email_lower || emailLower).trim().toLowerCase(),
  };
}

function normalizeSubscriptionBody(body) {
  const endpoint = String(body?.endpoint || "").trim();
  const keys = body?.keys || {};
  const p256dh = String(keys.p256dh || body?.p256dh || "").trim();
  const authKey = String(keys.auth || body?.auth || body?.auth_key || "").trim();
  if (!endpoint || !p256dh || !authKey) {
    return { ok: false, error: "invalid_push_subscription" };
  }
  return {
    ok: true,
    subscription: { endpoint, p256dh, authKey },
    prefs: {
      notifyNewTickets: body?.notifyNewTickets !== false && body?.notify_new_tickets !== false,
      notifyAmenityReservations:
        body?.notifyAmenityReservations !== false && body?.notify_amenity_reservations !== false,
    },
  };
}

async function upsertPushSubscription(o) {
  if (!ensureVapid()) return { ok: false, error: "portal_push_disabled" };
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "supabase_unavailable" };

  const auth = await resolvePortalAuthUserFromJwt(sb, o.accessToken);
  if (!auth.ok) return auth;

  const parsed = normalizeSubscriptionBody(o.body || {});
  if (!parsed.ok) return parsed;

  const now = new Date().toISOString();
  const row = {
    auth_user_id: auth.authUserId,
    email_lower: auth.emailLower,
    endpoint: parsed.subscription.endpoint,
    p256dh: parsed.subscription.p256dh,
    auth_key: parsed.subscription.authKey,
    user_agent: String(o.userAgent || "").slice(0, 512),
    notify_new_tickets: parsed.prefs.notifyNewTickets,
    notify_amenity_reservations: parsed.prefs.notifyAmenityReservations,
    active: true,
    updated_at: now,
  };

  const { error } = await sb.from("portal_push_subscriptions").upsert(row, {
    onConflict: "auth_user_id,endpoint",
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

async function deactivatePushSubscription(o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "supabase_unavailable" };

  const auth = await resolvePortalAuthUserFromJwt(sb, o.accessToken);
  if (!auth.ok) return auth;

  const endpoint = String(o.endpoint || o.body?.endpoint || "").trim();
  if (!endpoint) return { ok: false, error: "missing_endpoint" };

  const { error } = await sb
    .from("portal_push_subscriptions")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("auth_user_id", auth.authUserId)
    .eq("endpoint", endpoint);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

async function deactivateSubscriptionById(sb, id) {
  if (!sb || !id) return;
  await sb
    .from("portal_push_subscriptions")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("id", id);
}

async function listActiveSubscriptions(sb, eventType) {
  let query = sb.from("portal_push_subscriptions").select("*").eq("active", true);
  if (eventType === "new_ticket") {
    query = query.eq("notify_new_tickets", true);
  } else if (eventType === "amenity_reservation") {
    query = query.eq("notify_amenity_reservations", true);
  }
  const { data, error } = await query;
  if (error || !data) return [];
  return data;
}

async function sendPushToRow(sb, row, payload) {
  if (!ensureVapid()) return { ok: false, skipped: true };
  try {
    await webpush.sendNotification(
      {
        endpoint: row.endpoint,
        keys: {
          p256dh: row.p256dh,
          auth: row.auth_key,
        },
      },
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
 * @param {{ eventType: 'new_ticket'|'amenity_reservation', title: string, body: string, url: string, tag?: string }} o
 */
async function dispatchPortalPush(o) {
  if (!ensureVapid()) return { ok: false, skipped: true, reason: "portal_push_disabled" };
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "supabase_unavailable" };

  const eventType = String(o.eventType || "").trim();
  const title = String(o.title || "").trim();
  const body = String(o.body || "").trim();
  const url = String(o.url || "/tickets").trim() || "/tickets";
  if (!eventType || !title) return { ok: false, error: "missing_push_fields" };

  const payload = {
    title,
    body,
    url,
    tag: String(o.tag || eventType).trim() || eventType,
  };

  const rows = await listActiveSubscriptions(sb, eventType);
  if (!rows.length) return { ok: true, sent: 0, skipped: true };

  let sent = 0;
  for (const row of rows) {
    const r = await sendPushToRow(sb, row, payload);
    if (r.ok) sent += 1;
  }
  return { ok: true, sent };
}

async function notifyPortalPushNewTicket(o) {
  const ticketId = String(o.ticketId || "").trim();
  if (!ticketId) return { ok: false, skipped: true };
  const propertyCode = String(o.propertyCode || "").trim().toUpperCase();
  const unit = String(o.unitLabel || "").trim();
  const issue = String(o.issue || "").trim();
  const parts = [ticketId];
  if (propertyCode) parts.push(propertyCode);
  if (unit) parts.push(unit);
  const body = issue || parts.slice(1).join(" · ") || "New maintenance ticket";
  return dispatchPortalPush({
    eventType: "new_ticket",
    title: "New ticket",
    body,
    url: `/tickets?ticket=${encodeURIComponent(ticketId)}`,
    tag: `ticket-${ticketId}`,
  });
}

async function notifyPortalPushAmenityReservation(o) {
  const locationName = String(o.locationName || "Amenity").trim();
  const tenantName = String(o.tenantName || "").trim();
  const unitLabel = String(o.unitLabel || "").trim();
  const propertyCode = String(o.propertyCode || "").trim().toUpperCase();
  const needsApproval = o.needsApproval === true;
  const detailParts = [locationName];
  if (tenantName) detailParts.push(tenantName);
  if (unitLabel) detailParts.push(unitLabel);
  if (propertyCode) detailParts.push(propertyCode);
  return dispatchPortalPush({
    eventType: "amenity_reservation",
    title: needsApproval ? "Amenity reservation — approval needed" : "New amenity reservation",
    body: detailParts.join(" · "),
    url: "/access",
    tag: o.reservationId ? `reservation-${o.reservationId}` : "amenity-reservation",
  });
}

function getVapidPublicKeyForClient() {
  if (!portalPushEnabled()) return null;
  return vapidPublicKey() || null;
}

module.exports = {
  resolvePortalAuthUserFromJwt,
  upsertPushSubscription,
  deactivatePushSubscription,
  dispatchPortalPush,
  notifyPortalPushNewTicket,
  notifyPortalPushAmenityReservation,
  getVapidPublicKeyForClient,
};
