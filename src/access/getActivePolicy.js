const { getSupabase } = require("../db/supabase");

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} locationId
 * @param {Date} [at]
 * @returns {Promise<object|null>}
 */
async function getActivePolicy(sb, locationId, at = new Date()) {
  const lid = String(locationId || "").trim();
  if (!sb || !lid) return null;
  const atIso = at.toISOString();
  const { data, error } = await sb
    .from("access_location_policies")
    .select("*")
    .eq("location_id", lid)
    .lte("effective_from", atIso)
    .or(`effective_until.is.null,effective_until.gt.${atIso}`)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

module.exports = { getActivePolicy };
