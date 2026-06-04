/**
 * Jarvis staff visibility — org admin toggles per staff row.
 * @see docs/JARVIS_SPINE.md
 */

const { normalizePhoneE164 } = require("../utils/phone");
const { normOrgId } = require("../portal/portalOrgScope");

function normOrg(orgId) {
  return normOrgId(orgId);
}

function mapStaffJarvisRow(row, contact) {
  return {
    internalId: String(row.id || ""),
    staffId: String(row.staff_id || "").trim(),
    displayName: String(row.display_name || "").trim(),
    role: String(row.role || "").trim(),
    active: row.active !== false,
    phoneE164: contact ? String(contact.phone_e164 || "").trim() : "",
    jarvisVoiceEnabled: row.jarvis_voice_enabled !== false,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} orgId
 */
async function listStaffJarvisSettingsForOrg(sb, orgId) {
  if (!sb) return { ok: false, error: "no_db", staff: [] };
  const oid = normOrg(orgId);
  const { data: rows, error } = await sb
    .from("staff")
    .select("id, staff_id, display_name, role, active, org_id, contact_id, jarvis_voice_enabled")
    .eq("org_id", oid)
    .order("display_name", { ascending: true });

  if (error) {
    if (/jarvis_voice_enabled|column/i.test(String(error.message || ""))) {
      return { ok: false, error: "migration_required", staff: [] };
    }
    return { ok: false, error: error.message, staff: [] };
  }

  const contactIds = (rows || []).map((r) => r.contact_id).filter(Boolean);
  const contactsById = {};
  if (contactIds.length) {
    const { data: contacts } = await sb
      .from("contacts")
      .select("id, phone_e164")
      .in("id", contactIds);
    for (const c of contacts || []) {
      contactsById[c.id] = c;
    }
  }

  return {
    ok: true,
    staff: (rows || []).map((r) => mapStaffJarvisRow(r, contactsById[r.contact_id])),
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} orgId
 * @param {string} staffIdText
 * @param {{ jarvisVoiceEnabled?: boolean }} patch
 */
async function patchStaffJarvisSettingForOrg(sb, orgId, staffIdText, patch) {
  if (!sb) return { ok: false, error: "no_db" };
  const oid = normOrg(orgId);
  const sid = String(staffIdText || "").trim();
  if (!sid) return { ok: false, error: "missing_staff_id", status: 400 };

  if (patch.jarvisVoiceEnabled == null && patch.jarvis_voice_enabled == null) {
    return { ok: false, error: "no_changes", status: 400 };
  }

  const enabled = patch.jarvisVoiceEnabled ?? patch.jarvis_voice_enabled;
  const jarvis_voice_enabled = enabled === true || enabled === "1" || enabled === 1;

  const { data: row, error } = await sb
    .from("staff")
    .update({ jarvis_voice_enabled })
    .eq("org_id", oid)
    .eq("staff_id", sid)
    .select("id, staff_id, display_name, role, active, org_id, contact_id, jarvis_voice_enabled")
    .maybeSingle();

  if (error) {
    if (/jarvis_voice_enabled|column/i.test(String(error.message || ""))) {
      return { ok: false, error: "migration_required", status: 503 };
    }
    return { ok: false, error: error.message, status: 500 };
  }
  if (!row) return { ok: false, error: "staff_not_found", status: 404 };

  let contact = null;
  if (row.contact_id) {
    const { data: c } = await sb
      .from("contacts")
      .select("id, phone_e164")
      .eq("id", row.contact_id)
      .maybeSingle();
    contact = c;
  }

  return { ok: true, staff: mapStaffJarvisRow(row, contact) };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ orgId?: string, staffId?: string, phoneE164?: string }} hints
 */
async function resolveJarvisVoiceEnabledForStaff(sb, hints) {
  if (!sb) return true;
  const oid = normOrg(hints.orgId);
  const staffId = String(hints.staffId || "").trim();
  const phone = normalizePhoneE164(String(hints.phoneE164 || ""));

  if (!staffId && !phone) return true;

  if (staffId) {
    let q = sb
      .from("staff")
      .select("jarvis_voice_enabled")
      .eq("staff_id", staffId)
      .limit(1);
    if (oid) q = q.eq("org_id", oid);
    const { data, error } = await q.maybeSingle();
    if (error && /jarvis_voice_enabled|column/i.test(String(error.message || ""))) return true;
    if (!data) return true;
    return data.jarvis_voice_enabled !== false;
  }

  const { data: contact } = await sb
    .from("contacts")
    .select("id")
    .eq("phone_e164", phone)
    .maybeSingle();
  if (!contact?.id) return true;

  let q = sb
    .from("staff")
    .select("jarvis_voice_enabled")
    .eq("contact_id", contact.id)
    .limit(1);
  if (oid) q = q.eq("org_id", oid);
  const { data, error } = await q.maybeSingle();
  if (error && /jarvis_voice_enabled|column/i.test(String(error.message || ""))) return true;
  if (!data) return true;
  return data.jarvis_voice_enabled !== false;
}

module.exports = {
  listStaffJarvisSettingsForOrg,
  patchStaffJarvisSettingForOrg,
  resolveJarvisVoiceEnabledForStaff,
};
