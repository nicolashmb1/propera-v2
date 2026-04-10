/**
 * Property row for ticket / intake display — from public.properties.
 */
const { getSupabase } = require("../db/supabase");

/**
 * @param {string} propertyCode — e.g. MURRAY, PENN
 * @returns {Promise<{ code: string, display_name: string, ticket_prefix: string, legacy_property_id: string } | null>}
 */
async function getPropertyByCode(propertyCode) {
  const code = String(propertyCode || "").trim().toUpperCase();
  if (!code) return null;
  const sb = getSupabase();
  if (!sb) return null;

  const { data, error } = await sb
    .from("properties")
    .select("code, display_name, ticket_prefix, legacy_property_id")
    .eq("code", code)
    .maybeSingle();

  if (error || !data) return null;
  return {
    code: data.code,
    display_name: String(data.display_name || ""),
    ticket_prefix: String(data.ticket_prefix || data.code || "").trim(),
    legacy_property_id: String(data.legacy_property_id || ""),
  };
}

module.exports = { getPropertyByCode };
