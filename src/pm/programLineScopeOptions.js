/**
 * Building-structure scope options for manual program line add (portal).
 * @see docs/PM_PROGRAM_ENGINE_V1.md
 */

const { formatUnitScopeLabel } = require("./expandProgramLines");
const { loadActiveCommonAreaLabelsForProperty } = require("../dal/propertyLocations");

const SCOPE_TYPES = new Set(["UNIT", "COMMON_AREA", "FLOOR", "SITE"]);

/**
 * @param {string} scopeType
 * @param {string} scopeLabel
 * @returns {string}
 */
function scopeOptionKey(scopeType, scopeLabel) {
  return `${String(scopeType || "").trim().toUpperCase()}:${String(scopeLabel || "").trim().toLowerCase()}`;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
function normalizeProfile(raw) {
  if (raw == null) return {};
  if (typeof raw === "string") {
    try {
      const o = JSON.parse(raw);
      return o && typeof o === "object" && !Array.isArray(o) ? o : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) return /** @type {Record<string, unknown>} */ (raw);
  return {};
}

/**
 * @param {Record<string, unknown>} profile
 * @param {string[]} canonicalCommon
 * @returns {string[]}
 */
function mergeCommonLabels(profile, canonicalCommon) {
  const seen = new Set();
  const out = [];
  const push = (label) => {
    const s = String(label || "").trim();
    if (!s) return;
    const k = s.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };
  const fromProfile = profile.common_paint_scopes;
  if (Array.isArray(fromProfile)) {
    for (const x of fromProfile) push(x);
  }
  if (Array.isArray(canonicalCommon)) {
    for (const x of canonicalCommon) push(x);
  }
  return out;
}

/**
 * @param {object} o
 * @param {Record<string, unknown>} [o.expansionProfile]
 * @param {string[]} [o.canonicalCommonAreaLabels]
 * @param {{ unit_label?: string }[]} [o.unitRows]
 * @returns {{ scope_type: string; scope_label: string }[]}
 */
function buildPropertyStructureScopeSpecs(o) {
  const profile = normalizeProfile(o?.expansionProfile);
  const specs = [];

  const unitRows = Array.isArray(o?.unitRows) ? o.unitRows : [];
  for (const row of unitRows) {
    const label = formatUnitScopeLabel(row.unit_label);
    specs.push({ scope_type: "UNIT", scope_label: label });
  }

  const floors = profile.floor_paint_scopes;
  if (Array.isArray(floors)) {
    for (const x of floors) {
      const label = String(x || "").trim();
      if (label) specs.push({ scope_type: "FLOOR", scope_label: label });
    }
  }

  const commons = mergeCommonLabels(profile, o?.canonicalCommonAreaLabels || []);
  for (const label of commons) {
    specs.push({ scope_type: "COMMON_AREA", scope_label: label });
  }

  return specs;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {string} propertyCode
 * @returns {Promise<{ scope_type: string; scope_label: string }[]>}
 */
async function loadPropertyStructureScopeSpecs(sb, propertyCode) {
  const code = String(propertyCode || "").trim().toUpperCase();
  if (!sb || !code) return [];

  const { data: propRow } = await sb
    .from("properties")
    .select("program_expansion_profile")
    .eq("code", code)
    .maybeSingle();

  const { data: roster } = await sb
    .from("tenant_roster")
    .select("unit_label")
    .eq("property_code", code)
    .eq("active", true);

  const canonicalCommon = await loadActiveCommonAreaLabelsForProperty(code);

  return buildPropertyStructureScopeSpecs({
    expansionProfile: propRow?.program_expansion_profile,
    canonicalCommonAreaLabels: canonicalCommon,
    unitRows: roster || [],
  });
}

/**
 * When property has building structure, manual add must match unless scopeType is SITE (custom).
 * @param {object} o
 * @param {{ scope_type: string; scope_label: string }[]} o.allowedSpecs
 * @param {string} o.scopeType
 * @param {string} o.scopeLabel
 * @returns {{ ok: boolean; error?: string }}
 */
function validateManualLineAgainstStructure(o) {
  const scopeType = String(o?.scopeType || "")
    .trim()
    .toUpperCase();
  const scopeLabel = String(o?.scopeLabel || "").trim();
  const allowed = Array.isArray(o?.allowedSpecs) ? o.allowedSpecs : [];

  if (!SCOPE_TYPES.has(scopeType)) {
    return { ok: false, error: "invalid_scope_type" };
  }
  if (!scopeLabel) return { ok: false, error: "missing_scope_label" };

  if (scopeType === "SITE") {
    return { ok: true };
  }

  if (!allowed.length) {
    return { ok: true };
  }

  const key = scopeOptionKey(scopeType, scopeLabel);
  const hit = allowed.some(
    (s) => scopeOptionKey(s.scope_type, s.scope_label) === key
  );
  if (!hit) {
    return { ok: false, error: "label_not_in_property_structure" };
  }
  return { ok: true };
}

module.exports = {
  scopeOptionKey,
  buildPropertyStructureScopeSpecs,
  loadPropertyStructureScopeSpecs,
  validateManualLineAgainstStructure,
};
