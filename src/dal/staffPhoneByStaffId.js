/**
 * Resolve staff E.164 from sheet-style `staff_id` (e.g. STAFF_NICK) — `work_items.owner_id`.
 */
const { getSupabase } = require("../db/supabase");

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} [sb]
 * @param {string} staffId — `staff.staff_id`
 * @returns {Promise<string>}
 */
async function getStaffPhoneE164ByStaffId(sb, staffId) {
  const id = String(staffId || "").trim();
  const client = sb || getSupabase();
  if (!client || !id) return "";

  const { data: staff, error } = await client
    .from("staff")
    .select("contact_id, active")
    .eq("staff_id", id)
    .maybeSingle();

  if (error || !staff || staff.active === false) return "";

  const { data: c } = await client
    .from("contacts")
    .select("phone_e164")
    .eq("id", staff.contact_id)
    .maybeSingle();

  return c && c.phone_e164 ? String(c.phone_e164).trim() : "";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} [sb]
 * @param {string} staffId — `staff.staff_id`
 * @returns {Promise<string>} display name, or "" if missing/inactive
 */
async function getStaffDisplayNameByStaffId(sb, staffId) {
  const id = String(staffId || "").trim();
  const client = sb || getSupabase();
  if (!client || !id) return "";

  const { data: staff, error } = await client
    .from("staff")
    .select("display_name, active")
    .eq("staff_id", id)
    .maybeSingle();

  if (error || !staff || staff.active === false) return "";
  return String(staff.display_name || "").trim();
}

module.exports = { getStaffPhoneE164ByStaffId, getStaffDisplayNameByStaffId };
