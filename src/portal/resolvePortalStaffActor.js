/**
 * Resolve portal PM identity for auditable ticket mutations (JWT → allowlist → staff).
 */
const {
  staffTicketActor,
} = require("../dal/ticketAuditPatch");

function portalActorJwtRequired() {
  const explicit = String(process.env.PROPERA_PORTAL_ACTOR_JWT_REQUIRED || "").trim().toLowerCase();
  if (explicit === "0" || explicit === "false") return false;
  if (explicit === "1" || explicit === "true") return true;
  return String(process.env.NODE_ENV || "development").toLowerCase() === "production";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} staffIdText — `staff.staff_id`
 * @param {string} [source]
 * @returns {Promise<{ ok: boolean, changedBy?: Record<string, string>, error?: string }>}
 */
async function buildChangedByFromStaffIdText(sb, staffIdText, source) {
  const sid = String(staffIdText || "").trim();
  if (!sid) return { ok: false, error: "missing_staff_id" };
  const { data: staff, error } = await sb
    .from("staff")
    .select("staff_id, display_name")
    .eq("staff_id", sid)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!staff) return { ok: false, error: "staff_not_found" };
  const label = String(staff.display_name || "").trim() || sid;
  return {
    ok: true,
    changedBy: staffTicketActor({
      staffId: sid,
      displayName: label,
      source: source || "propera_app",
    }),
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string | null | undefined} accessToken — Supabase user JWT (Bearer)
 * @returns {Promise<{ ok: boolean, changedBy?: Record<string, string>, error?: string }>}
 */
async function resolvePortalStaffActorFromJwt(sb, accessToken) {
  const tok = String(accessToken || "").trim();
  if (!tok) return { ok: false, error: "missing_portal_access_token" };

  const { data: userData, error: authErr } = await sb.auth.getUser(tok);
  if (authErr || !userData || !userData.user) {
    return { ok: false, error: "invalid_portal_access_token" };
  }
  const user = userData.user;
  const uid = String(user.id || "").trim();
  const emailLower = user.email ? String(user.email).trim().toLowerCase() : "";

  let allow = null;
  if (uid) {
    const { data: byUid } = await sb
      .from("portal_auth_allowlist")
      .select("staff_id, portal_role, active, email_lower, auth_user_id")
      .eq("auth_user_id", uid)
      .eq("active", true)
      .maybeSingle();
    if (byUid) allow = byUid;
  }
  if (!allow && emailLower) {
    const { data: byEmail } = await sb
      .from("portal_auth_allowlist")
      .select("staff_id, portal_role, active, email_lower, auth_user_id")
      .eq("email_lower", emailLower)
      .eq("active", true)
      .maybeSingle();
    if (byEmail) allow = byEmail;
  }

  if (!allow) return { ok: false, error: "portal_user_not_allowlisted" };

  const staffIdText = String(allow.staff_id || "").trim();
  if (!staffIdText) return { ok: false, error: "portal_user_staff_not_linked" };

  const staffRes = await buildChangedByFromStaffIdText(sb, staffIdText, "propera_app");
  if (!staffRes.ok) return staffRes;
  return { ok: true, changedBy: staffRes.changedBy };
}

/**
 * Portal transport: prefer JWT when present / required; else staff row from linked phone (dev ergonomics).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {object} o
 * @param {string} [o.accessToken]
 * @param {{ staff?: { staff_id?: string, display_name?: string } | null, isStaff?: boolean }} [o.staffContext]
 * @param {'portal'|'telegram'|'sms'|'whatsapp'} [o.transportChannel]
 * @returns {Promise<{ ok: boolean, changedBy?: Record<string, string>, error?: string }>}
 */
async function resolvePortalTicketMutationActor(sb, o) {
  const accessToken = o && o.accessToken != null ? String(o.accessToken).trim() : "";
  const staffContext = (o && o.staffContext) || {};
  const transport = String((o && o.transportChannel) || "portal").toLowerCase();

  if (accessToken) {
    const r = await resolvePortalStaffActorFromJwt(sb, accessToken);
    if (r.ok) return r;
    if (portalActorJwtRequired()) return r;
  }

  if (portalActorJwtRequired()) {
    return { ok: false, error: accessToken ? "invalid_portal_actor" : "missing_portal_access_token" };
  }

  if (staffContext.isStaff && staffContext.staff && String(staffContext.staff.staff_id || "").trim()) {
    const sid = String(staffContext.staff.staff_id || "").trim();
    const label = String(staffContext.staff.display_name || "").trim() || sid;
    const src =
      transport === "telegram"
        ? "telegram"
        : transport === "sms"
          ? "sms"
          : transport === "whatsapp"
            ? "whatsapp"
            : "propera_app";
    return { ok: true, changedBy: staffTicketActor({ staffId: sid, displayName: label, source: src }) };
  }

  return { ok: false, error: "portal_actor_unresolved" };
}

module.exports = {
  portalActorJwtRequired,
  resolvePortalStaffActorFromJwt,
  buildChangedByFromStaffIdText,
  resolvePortalTicketMutationActor,
};
