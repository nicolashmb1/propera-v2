/**
 * Org-scoped portal reads — property codes and row filters for MO-1.
 */
const { defaultOrgId } = require("../config/env");

function normOrgId(orgId) {
  return String(orgId || "")
    .trim()
    .toLowerCase();
}

function normPropCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase();
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} orgId
 * @returns {Promise<{ orgId: string, propertyCodes: string[], propertyCodesUpper: Set<string> }>}
 */
async function loadOrgPropertyScope(sb, orgId) {
  const oid = normOrgId(orgId) || normOrgId(defaultOrgId());
  if (!sb || !oid) {
    return { orgId: oid || "", propertyCodes: [], propertyCodesUpper: new Set() };
  }

  const { data, error } = await sb
    .from("properties")
    .select("code")
    .eq("org_id", oid)
    .eq("active", true);

  if (error || !Array.isArray(data)) {
    return { orgId: oid, propertyCodes: [], propertyCodesUpper: new Set() };
  }

  const propertyCodes = data
    .map((r) => normPropCode(r.code))
    .filter((c) => c && c !== "GLOBAL");

  return {
    orgId: oid,
    propertyCodes,
    propertyCodesUpper: new Set(propertyCodes),
  };
}

/**
 * @param {string | undefined | null} propertyCode
 * @param {{ propertyCodesUpper?: Set<string> }} scope
 */
function propertyCodeInOrgScope(propertyCode, scope) {
  const set = scope && scope.propertyCodesUpper;
  if (!set || !set.size) return true;
  const code = normPropCode(propertyCode);
  if (!code) return false;
  return set.has(code);
}

/**
 * @param {Array<{ property_code?: string, propertyCode?: string }>} rows
 * @param {{ propertyCodesUpper?: Set<string> }} scope
 */
function filterRowsByOrgPropertyScope(rows, scope) {
  const list = rows || [];
  const set = scope && scope.propertyCodesUpper;
  if (!set || !set.size) return list;
  return list.filter((row) => {
    const code = normPropCode(row.property_code || row.propertyCode);
    return code && set.has(code);
  });
}

module.exports = {
  normOrgId,
  normPropCode,
  loadOrgPropertyScope,
  propertyCodeInOrgScope,
  filterRowsByOrgPropertyScope,
};
