/**
 * Property office / super contact for tenant deflect replies (read-only roster lookup).
 */
const { getSupabase } = require("../../db/supabase");
const { commMainNumberDisplay } = require("../../config/env");
const { normalizePhoneE164 } = require("../../utils/phone");

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} propertyCode
 * @param {string} rolePrefix — e.g. SUPER| or PM|
 * @returns {Promise<string>}
 */
async function staffPhoneForPropertyRole(sb, propertyCode, rolePrefix) {
  const code = String(propertyCode || "").trim().toUpperCase();
  const prefix = String(rolePrefix || "").trim();
  if (!code || !prefix || !sb) return "";

  const { data: assignments, error } = await sb
    .from("staff_assignments")
    .select("staff_id, role")
    .eq("property_code", code);

  if (error || !Array.isArray(assignments) || !assignments.length) return "";

  const slot = assignments.find((a) =>
    String(a.role || "")
      .trim()
      .startsWith(prefix)
  );
  if (!slot || !slot.staff_id) return "";

  const { data: staff } = await sb
    .from("staff")
    .select("contact_id, active")
    .eq("id", slot.staff_id)
    .maybeSingle();

  if (!staff || staff.active === false || !staff.contact_id) return "";

  const { data: contact } = await sb
    .from("contacts")
    .select("phone_e164")
    .eq("id", staff.contact_id)
    .maybeSingle();

  return contact && contact.phone_e164
    ? String(contact.phone_e164).trim()
    : "";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} tenantActorKey
 * @returns {Promise<string>}
 */
async function propertyCodeFromTenantPhone(sb, tenantActorKey) {
  const phone = normalizePhoneE164(String(tenantActorKey || "").trim());
  if (!phone || !sb) return "";

  const { data: rows, error } = await sb
    .from("tenant_roster")
    .select("property_code")
    .eq("phone_e164", phone)
    .eq("active", true);

  if (error || !Array.isArray(rows) || rows.length !== 1) return "";
  return String(rows[0].property_code || "").trim().toUpperCase();
}

/**
 * @param {object} o
 * @param {string} [o.propertyCode]
 * @param {string} [o.tenantActorKey]
 * @returns {Promise<{ phoneE164: string, propertyCode: string, source: string }>}
 */
async function resolvePropertyStaffContact(o) {
  const sb = getSupabase();
  let propertyCode = String(o.propertyCode || "").trim().toUpperCase();

  if (!propertyCode && sb) {
    propertyCode = await propertyCodeFromTenantPhone(sb, o.tenantActorKey);
  }

  if (sb && propertyCode) {
    for (const slot of ["SUPER|", "PM|"]) {
      const phoneE164 = await staffPhoneForPropertyRole(sb, propertyCode, slot);
      if (phoneE164) {
        return { phoneE164, propertyCode, source: slot.replace("|", "") };
      }
    }
  }

  const fallback = String(commMainNumberDisplay() || "").trim();
  return {
    phoneE164: fallback,
    propertyCode,
    source: fallback ? "global" : "",
  };
}

module.exports = {
  resolvePropertyStaffContact,
  staffPhoneForPropertyRole,
  propertyCodeFromTenantPhone,
};
