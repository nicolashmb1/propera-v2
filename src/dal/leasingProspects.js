/**
 * Leasing Engine V1 — DAL
 * Org-scoped portal reads/writes (fail-closed — no cross-org leak).
 */
const { getSupabase } = require("../db/supabase");
const {
  normPropCode,
  resolveOrgPropertyScopeForQuery,
  assertPropertyInOrgScope,
} = require("../portal/portalOrgScope");

const RENEWAL_STATUSES = ["pending", "renewing", "vacating"];
const PROSPECT_STATUSES = ["new", "toured", "applied", "approved", "signed", "lost"];

function scopedPropertyCodes(orgScope) {
  const scope = resolveOrgPropertyScopeForQuery(orgScope);
  if (!scope.ok) return scope;
  return scope;
}

async function assertUnitInProperty(sb, unitCatalogId, propertyCode) {
  if (!unitCatalogId) return { ok: true };
  const { data, error } = await sb
    .from("units")
    .select("id, property_code")
    .eq("id", unitCatalogId)
    .maybeSingle();
  if (error) throw new Error(`assertUnitInProperty: ${error.message}`);
  if (!data) return { ok: false, error: "unit_not_found" };
  if (normPropCode(data.property_code) !== normPropCode(propertyCode)) {
    return { ok: false, error: "unit_property_mismatch" };
  }
  return { ok: true };
}

async function listExpiringLeasesForPortal({ orgScope, propertyCode, renewalStatus, days = 90 } = {}) {
  const scope = scopedPropertyCodes(orgScope);
  if (!scope.ok) return [];

  const sb = getSupabase();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const todayIso = new Date().toISOString().slice(0, 10);

  let q = sb
    .from("unit_leases")
    .select(`
      id,
      unit_catalog_id,
      property_code,
      rent_cents,
      lease_start,
      lease_end,
      renewal_status,
      renewal_notes,
      notes,
      updated_at,
      units!unit_catalog_id (
        id,
        unit_label,
        floor,
        bedrooms,
        bathrooms,
        status
      )
    `)
    .in("property_code", scope.propertyCodes)
    .not("lease_end", "is", null)
    .lte("lease_end", cutoffIso)
    .gte("lease_end", todayIso)
    .order("lease_end", { ascending: true });

  if (propertyCode) {
    const prop = assertPropertyInOrgScope(propertyCode, orgScope);
    if (!prop.ok) return [];
    q = q.eq("property_code", prop.propertyCode);
  }
  if (renewalStatus) {
    if (!RENEWAL_STATUSES.includes(renewalStatus)) {
      throw new Error(`Invalid renewalStatus: ${renewalStatus}`);
    }
    q = q.eq("renewal_status", renewalStatus);
  }

  const { data, error } = await q;
  if (error) throw new Error(`listExpiringLeasesForPortal: ${error.message}`);
  return data || [];
}

async function patchLeaseRenewalStatus({ leaseId, renewalStatus, renewalNotes, propertyCode, orgScope }) {
  if (!leaseId) throw new Error("leaseId required");

  const scope = scopedPropertyCodes(orgScope);
  if (!scope.ok) throw new Error(scope.error);

  if (renewalStatus && !RENEWAL_STATUSES.includes(renewalStatus)) {
    throw new Error(`Invalid renewalStatus: ${renewalStatus}`);
  }

  const sb = getSupabase();
  const patch = {};
  if (renewalStatus !== undefined) patch.renewal_status = renewalStatus;
  if (renewalNotes !== undefined) patch.renewal_notes = String(renewalNotes).trim();
  if (!Object.keys(patch).length) throw new Error("Nothing to patch");

  let q = sb.from("unit_leases").update(patch).eq("id", leaseId).in("property_code", scope.propertyCodes);

  if (propertyCode) {
    const prop = assertPropertyInOrgScope(propertyCode, orgScope);
    if (!prop.ok) throw new Error(prop.error);
    q = q.eq("property_code", prop.propertyCode);
  }

  const { data, error } = await q.select("*").maybeSingle();
  if (error) throw new Error(`patchLeaseRenewalStatus: ${error.message}`);
  return data;
}

async function listProspectsForPortal({ orgScope, propertyCode, status, unitId } = {}) {
  const scope = scopedPropertyCodes(orgScope);
  if (!scope.ok) return [];

  const sb = getSupabase();
  let q = sb
    .from("leasing_prospects")
    .select(`
      *,
      units!unit_catalog_id (
        id,
        unit_label,
        floor,
        bedrooms,
        bathrooms
      )
    `)
    .in("property_code", scope.propertyCodes)
    .order("target_move_in", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (scope.orgId) {
    q = q.eq("org_id", scope.orgId);
  }
  if (propertyCode) {
    const prop = assertPropertyInOrgScope(propertyCode, orgScope);
    if (!prop.ok) return [];
    q = q.eq("property_code", prop.propertyCode);
  }
  if (status) {
    if (!PROSPECT_STATUSES.includes(status)) throw new Error(`Invalid status: ${status}`);
    q = q.eq("status", status);
  }
  if (unitId) {
    q = q.eq("unit_catalog_id", unitId);
  }

  const { data, error } = await q;
  if (error) throw new Error(`listProspectsForPortal: ${error.message}`);
  return data || [];
}

async function createProspectForPortal({ orgScope, body }) {
  const scope = scopedPropertyCodes(orgScope);
  if (!scope.ok) throw new Error(scope.error);

  const propertyCode = typeof body.property_code === "string"
    ? body.property_code.toUpperCase().trim()
    : null;
  if (!propertyCode) throw new Error("property_code required");

  const prop = assertPropertyInOrgScope(propertyCode, orgScope);
  if (!prop.ok) throw new Error(prop.error);

  const sb = getSupabase();
  const unitCatalogId = body.unit_catalog_id || null;
  if (unitCatalogId) {
    const unitOk = await assertUnitInProperty(sb, unitCatalogId, prop.propertyCode);
    if (!unitOk.ok) throw new Error(unitOk.error);
  }

  const row = {
    org_id: scope.orgId,
    property_code: prop.propertyCode,
    unit_catalog_id: unitCatalogId,
    name: String(body.name || "").trim(),
    phone: String(body.phone || "").trim(),
    email: String(body.email || "").trim(),
    desired_bedrooms: body.desired_bedrooms != null ? parseInt(body.desired_bedrooms, 10) || null : null,
    desired_bathrooms: body.desired_bathrooms != null ? parseInt(body.desired_bathrooms, 10) || null : null,
    budget_min_cents: body.budget_min_cents != null ? Math.max(0, Math.round(Number(body.budget_min_cents))) : null,
    budget_max_cents: body.budget_max_cents != null ? Math.max(0, Math.round(Number(body.budget_max_cents))) : null,
    target_move_in: typeof body.target_move_in === "string" && body.target_move_in ? body.target_move_in : null,
    status: "new",
    source: String(body.source || "").trim(),
    notes: String(body.notes || "").trim(),
    created_by: String(body.created_by || "").trim(),
  };

  const { data, error } = await sb.from("leasing_prospects").insert(row).select("*").maybeSingle();
  if (error) throw new Error(`createProspectForPortal: ${error.message}`);
  return data;
}

async function patchProspectForPortal({ prospectId, orgScope, body }) {
  if (!prospectId) throw new Error("prospectId required");

  const scope = scopedPropertyCodes(orgScope);
  if (!scope.ok) throw new Error(scope.error);

  const sb = getSupabase();
  const { data: existing, error: loadErr } = await sb
    .from("leasing_prospects")
    .select("id, property_code, unit_catalog_id, status")
    .eq("id", prospectId)
    .in("property_code", scope.propertyCodes)
    .eq("org_id", scope.orgId)
    .maybeSingle();
  if (loadErr) throw new Error(`patchProspectForPortal: ${loadErr.message}`);
  if (!existing) return null;

  const patch = {};
  if (body.status !== undefined) {
    if (!PROSPECT_STATUSES.includes(body.status)) throw new Error(`Invalid status: ${body.status}`);
    patch.status = body.status;
  }
  if (body.name !== undefined) patch.name = String(body.name).trim();
  if (body.phone !== undefined) patch.phone = String(body.phone).trim();
  if (body.email !== undefined) patch.email = String(body.email).trim();
  if (body.unit_catalog_id !== undefined) patch.unit_catalog_id = body.unit_catalog_id || null;
  if (body.desired_bedrooms !== undefined) {
    patch.desired_bedrooms = body.desired_bedrooms != null ? parseInt(body.desired_bedrooms, 10) || null : null;
  }
  if (body.desired_bathrooms !== undefined) {
    patch.desired_bathrooms = body.desired_bathrooms != null ? parseInt(body.desired_bathrooms, 10) || null : null;
  }
  if (body.budget_min_cents !== undefined) {
    patch.budget_min_cents = body.budget_min_cents != null ? Math.max(0, Math.round(Number(body.budget_min_cents))) : null;
  }
  if (body.budget_max_cents !== undefined) {
    patch.budget_max_cents = body.budget_max_cents != null ? Math.max(0, Math.round(Number(body.budget_max_cents))) : null;
  }
  if (body.target_move_in !== undefined) patch.target_move_in = body.target_move_in || null;
  if (body.source !== undefined) patch.source = String(body.source).trim();
  if (body.notes !== undefined) patch.notes = String(body.notes).trim();

  if (!Object.keys(patch).length) throw new Error("Nothing to patch");

  const targetProperty = existing.property_code;
  if (patch.unit_catalog_id) {
    const unitOk = await assertUnitInProperty(sb, patch.unit_catalog_id, targetProperty);
    if (!unitOk.ok) throw new Error(unitOk.error);
  }

  const { data, error } = await sb
    .from("leasing_prospects")
    .update(patch)
    .eq("id", prospectId)
    .in("property_code", scope.propertyCodes)
    .eq("org_id", scope.orgId)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`patchProspectForPortal: ${error.message}`);
  return { prospect: data, previous_status: String(existing.status || "").trim().toLowerCase() };
}

async function deleteProspectForPortal({ prospectId, orgScope }) {
  if (!prospectId) throw new Error("prospectId required");

  const scope = scopedPropertyCodes(orgScope);
  if (!scope.ok) throw new Error(scope.error);

  const sb = getSupabase();
  const { data, error } = await sb
    .from("leasing_prospects")
    .delete()
    .eq("id", prospectId)
    .in("property_code", scope.propertyCodes)
    .eq("org_id", scope.orgId)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`deleteProspectForPortal: ${error.message}`);
  if (!data) return null;
  return { ok: true };
}

module.exports = {
  listExpiringLeasesForPortal,
  patchLeaseRenewalStatus,
  listProspectsForPortal,
  createProspectForPortal,
  patchProspectForPortal,
  deleteProspectForPortal,
};
