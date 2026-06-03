/**
 * Voice caller roster lookup — no tenant-agent pilot filter (voice serves all portal-enabled residents).
 */
const { getSupabase } = require("../db/supabase");
const { normalizePhoneE164 } = require("../utils/phone");
const { normalizeUnit_ } = require("../brain/shared/extractUnitGas");

function pickUniqueRosterRow(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.active !== false);
  if (!list.length) return null;

  const byLocation = new Map();
  for (const row of list) {
    const key = [
      String(row.property_code || "").trim().toUpperCase(),
      normalizeUnit_(String(row.unit_label || "")),
    ].join("|");
    const prev = byLocation.get(key);
    if (!prev) {
      byLocation.set(key, row);
      continue;
    }
    const prevAt = new Date(prev.updated_at || 0).getTime();
    const rowAt = new Date(row.updated_at || 0).getTime();
    if (rowAt > prevAt) byLocation.set(key, row);
  }

  if (byLocation.size !== 1) return null;
  return byLocation.values().next().value || null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient | null | undefined} sb
 * @param {string} phoneE164
 * @returns {Promise<{ matched: boolean, row?: object, phoneE164?: string }>}
 */
async function lookupCallerRoster(sb, phoneE164) {
  const client = sb || getSupabase();
  const phone = normalizePhoneE164(phoneE164);
  if (!client || !phone) return { matched: false };

  const { data, error } = await client
    .from("tenant_roster")
    .select("id, property_code, unit_label, phone_e164, resident_name, active, updated_at, portal_enabled")
    .eq("phone_e164", phone)
    .eq("active", true)
    .order("updated_at", { ascending: false });

  if (error || !data || !data.length) {
    return { matched: false, phoneE164: phone };
  }

  const eligible = data.filter((r) => r.portal_enabled !== false);
  const row = pickUniqueRosterRow(eligible.length ? eligible : data);
  if (!row) return { matched: false, phoneE164: phone };

  return {
    matched: true,
    phoneE164: phone,
    row: {
      roster_id: String(row.id || "").trim(),
      property_code: String(row.property_code || "").trim().toUpperCase(),
      unit_label: String(row.unit_label || "").trim(),
      resident_name: String(row.resident_name || "").trim(),
      phone_e164: phone,
    },
  };
}

module.exports = { lookupCallerRoster };
