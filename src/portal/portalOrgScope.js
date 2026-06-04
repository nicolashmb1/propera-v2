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

/**
 * Fail-closed org property scope for portal DAL queries.
 * Empty property list → no rows (never cross-org leak).
 * @param {{ orgId?: string, propertyCodes?: string[] } | null | undefined} orgScope
 * @returns {{ ok: true, orgId: string, propertyCodes: string[] } | { ok: false, error: string }}
 */
function resolveOrgPropertyScopeForQuery(orgScope) {
  const orgId = normOrgId(orgScope && orgScope.orgId);
  if (!orgId) {
    return { ok: false, error: "org_context_required" };
  }
  const propertyCodes = Array.isArray(orgScope && orgScope.propertyCodes)
    ? orgScope.propertyCodes.map(normPropCode).filter(Boolean)
    : [];
  if (!propertyCodes.length) {
    return { ok: false, error: "org_has_no_properties" };
  }
  return { ok: true, orgId, propertyCodes };
}

/**
 * @param {string | undefined | null} propertyCode
 * @param {{ orgId?: string, propertyCodes?: string[] } | null | undefined} orgScope
 */
function assertPropertyInOrgScope(propertyCode, orgScope) {
  const scope = resolveOrgPropertyScopeForQuery(orgScope);
  if (!scope.ok) return scope;
  const code = normPropCode(propertyCode);
  if (!code) {
    return { ok: false, error: "property_code_required" };
  }
  if (!scope.propertyCodes.includes(code)) {
    return { ok: false, error: "property_code_not_in_org_scope" };
  }
  return { ok: true, orgId: scope.orgId, propertyCodes: scope.propertyCodes, propertyCode: code };
}

module.exports = {
  normOrgId,
  normPropCode,
  loadOrgPropertyScope,
  propertyCodeInOrgScope,
  filterRowsByOrgPropertyScope,
  resolveOrgPropertyScopeForQuery,
  assertPropertyInOrgScope,
};
