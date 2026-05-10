/**
 * Canonical building locations (`property_locations`) — common areas synced from program expansion profile.
 * @see supabase/migrations/033_property_locations.sql
 */

const { getSupabase } = require("../db/supabase");

const MAX_LABEL_LEN = 120;

/**
 * @param {string} propertyCode
 * @returns {Promise<{ ok: boolean; locations?: object[]; error?: string }>}
 */
async function listPropertyLocationsForPortal(propertyCode) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const code = String(propertyCode || "")
    .trim()
    .toUpperCase();
  if (!code || code === "GLOBAL") return { ok: false, error: "invalid_property_code" };

  const { data, error } = await sb
    .from("property_locations")
    .select("id, property_code, kind, label, aliases, active, sort_order")
    .eq("property_code", code)
    .eq("active", true)
    .order("sort_order", { ascending: true })
    .order("label", { ascending: true });

  if (error) return { ok: false, error: error.message || "list_failed" };
  return { ok: true, locations: data || [] };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {string} propertyCodeUpper
 * @param {string} locationId
 * @returns {Promise<object | null>}
 */
async function getActivePropertyLocationById(sb, propertyCodeUpper, locationId) {
  if (!sb || !locationId) return null;
  const id = String(locationId).trim();
  const pc = String(propertyCodeUpper || "").trim().toUpperCase();
  const { data, error } = await sb
    .from("property_locations")
    .select("id, property_code, kind, label, active")
    .eq("id", id)
    .eq("property_code", pc)
    .eq("active", true)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

/**
 * Keep `property_locations` rows in sync with `common_paint_scopes` labels (Building Structure).
 * Preserves stable UUIDs when labels match case-insensitively; soft-deactivates removed rows.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {string} propertyCodeUpper
 * @param {string[]} labelsOrdered
 */
async function syncCommonAreaLocationsFromLabels(sb, propertyCodeUpper, labelsOrdered) {
  const code = String(propertyCodeUpper || "").trim().toUpperCase();
  if (!sb || !code || code === "GLOBAL") return;

  const list = Array.isArray(labelsOrdered)
    ? labelsOrdered
        .map((x) =>
          String(x == null ? "" : x)
            .trim()
            .slice(0, MAX_LABEL_LEN)
        )
        .filter(Boolean)
    : [];

  const { data: existingRows, error: fetchErr } = await sb
    .from("property_locations")
    .select("id, label, active")
    .eq("property_code", code)
    .eq("kind", "common_area");

  if (fetchErr) return;

  const rows = Array.isArray(existingRows) ? existingRows : [];
  /** @type {Map<string, object>} */
  const byNorm = new Map();
  for (const r of rows) {
    const k = String(r.label || "")
      .trim()
      .toLowerCase();
    if (!k) continue;
    const prev = byNorm.get(k);
    if (!prev || (prev.active === false && r.active !== false)) byNorm.set(k, r);
    else if (!prev.active && r.active) byNorm.set(k, r);
  }

  const keptIds = new Set();
  let sortOrder = 0;
  for (const label of list) {
    const k = label.toLowerCase();
    const hit = byNorm.get(k);
    if (hit) {
      await sb
        .from("property_locations")
        .update({
          label,
          active: true,
          sort_order: sortOrder,
        })
        .eq("id", hit.id);
      keptIds.add(hit.id);
    } else {
      const { data: insRows, error: insErr } = await sb
        .from("property_locations")
        .insert({
          property_code: code,
          kind: "common_area",
          label,
          aliases: [],
          active: true,
          sort_order: sortOrder,
        })
        .select("id");
      const ins = Array.isArray(insRows) ? insRows[0] : insRows;
      if (!insErr && ins && ins.id) keptIds.add(ins.id);
    }
    sortOrder += 1;
  }

  for (const r of rows) {
    if (!keptIds.has(r.id)) {
      await sb.from("property_locations").update({ active: false }).eq("id", r.id);
    }
  }
}

module.exports = {
  listPropertyLocationsForPortal,
  getActivePropertyLocationById,
  syncCommonAreaLocationsFromLabels,
};
