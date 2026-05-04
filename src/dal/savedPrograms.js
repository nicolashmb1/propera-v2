/**
 * Property-scoped saved program definitions (PM / preventive).
 * @see docs/PM_PROGRAM_ENGINE_V1.md
 */
const { getSupabase } = require("../db/supabase");

const EXPANSION_TYPES = new Set([
  "UNIT_PLUS_COMMON",
  "FLOOR_BASED",
  "COMMON_AREA_ONLY",
  "CUSTOM_MANUAL",
]);

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseIncludedLabelsJson(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x || "").trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    try {
      const j = JSON.parse(raw);
      return Array.isArray(j) ? j.map((x) => String(x || "").trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * @param {object} o
 * @param {string} o.propertyCode
 * @param {string} o.displayName
 * @param {string} o.expansionType
 * @param {string[]} [o.defaultIncludedScopeLabels]
 * @param {string} [o.createdBy]
 * @returns {Promise<{ ok: boolean; program?: object; error?: string }>}
 */
async function createSavedProgram(o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const propertyCode = String(o.propertyCode || "")
    .trim()
    .toUpperCase();
  const displayName = String(o.displayName || "").trim();
  const expansionType = String(o.expansionType || "")
    .trim()
    .toUpperCase();

  if (!propertyCode) return { ok: false, error: "missing_property_code" };
  if (!displayName) return { ok: false, error: "missing_display_name" };
  if (!EXPANSION_TYPES.has(expansionType)) return { ok: false, error: "invalid_expansion_type" };

  const { data: prop } = await sb.from("properties").select("code").eq("code", propertyCode).maybeSingle();
  if (!prop) return { ok: false, error: "unknown_property" };

  const labels = Array.isArray(o.defaultIncludedScopeLabels)
    ? o.defaultIncludedScopeLabels.map((x) => String(x || "").trim()).filter(Boolean)
    : [];

  const createdBy = String(o.createdBy || "PORTAL").slice(0, 200);
  const now = new Date().toISOString();

  const insert = {
    property_code: propertyCode,
    display_name: displayName,
    expansion_type: expansionType,
    default_included_scope_labels: labels.length ? labels : null,
    active: true,
    archived_at: null,
    created_by: createdBy,
    created_at: now,
    updated_at: now,
  };

  const { data: row, error } = await sb
    .from("saved_programs")
    .insert(insert)
    .select(
      "id, property_code, display_name, expansion_type, default_included_scope_labels, active, archived_at, created_by, created_at, updated_at"
    )
    .maybeSingle();

  if (error || !row) {
    return { ok: false, error: error?.message || "insert_failed" };
  }
  return { ok: true, program: row };
}

/**
 * Active saved programs for one property (library).
 * @param {string} propertyCode
 * @returns {Promise<object[]>}
 */
async function listSavedPrograms(propertyCode) {
  const code = String(propertyCode || "").trim().toUpperCase();
  const sb = getSupabase();
  if (!sb || !code) return [];

  const { data, error } = await sb
    .from("saved_programs")
    .select(
      "id, property_code, display_name, expansion_type, default_included_scope_labels, active, archived_at, created_by, created_at, updated_at"
    )
    .eq("property_code", code)
    .eq("active", true)
    .order("display_name", { ascending: true });

  if (error || !data) return [];
  return data;
}

/**
 * By id (includes archived — for run resolution / FK integrity).
 * @param {string} id
 * @returns {Promise<object|null>}
 */
async function getSavedProgram(id) {
  const sid = String(id || "").trim();
  const sb = getSupabase();
  if (!sb || !sid) return null;

  const { data, error } = await sb
    .from("saved_programs")
    .select(
      "id, property_code, display_name, expansion_type, default_included_scope_labels, active, archived_at, created_by, created_at, updated_at"
    )
    .eq("id", sid)
    .maybeSingle();

  if (error || !data) return null;
  return data;
}

/**
 * Soft-delete (archive).
 * @param {string} id
 * @returns {Promise<{ ok: boolean; error?: string }>}
 */
async function archiveSavedProgram(id) {
  const sid = String(id || "").trim();
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };
  if (!sid) return { ok: false, error: "missing_id" };

  const now = new Date().toISOString();
  const { data: existing, error: fetchErr } = await sb
    .from("saved_programs")
    .select("id, active")
    .eq("id", sid)
    .maybeSingle();

  if (fetchErr) return { ok: false, error: fetchErr.message || "fetch_failed" };
  if (!existing) return { ok: false, error: "not_found" };

  const { error: upErr } = await sb
    .from("saved_programs")
    .update({
      active: false,
      archived_at: now,
      updated_at: now,
    })
    .eq("id", sid);

  if (upErr) return { ok: false, error: upErr.message || "update_failed" };
  return { ok: true };
}

module.exports = {
  createSavedProgram,
  listSavedPrograms,
  getSavedProgram,
  archiveSavedProgram,
  parseIncludedLabelsJson,
  EXPANSION_TYPES,
};
