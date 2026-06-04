/**
 * Unit occupancies V1 — time-bounded residency episodes (portal / service role).
 * @see docs/UNIT_LIFECYCLE_BUILD_PLAN.md Phase 1
 */
const { getSupabase } = require("../db/supabase");
const { appendEventLog } = require("./appendEventLog");

const CURRENT_STATUS = "current";
const PAST_STATUS = "past";

function normProp(code) {
  return String(code || "").trim().toUpperCase();
}

function normUnitLabel(label) {
  return String(label || "").trim();
}

/**
 * @param {object | null | undefined} leaseRow
 */
function leaseSnapshotFromRow(leaseRow) {
  if (!leaseRow || typeof leaseRow !== "object") return {};
  const snap = {
    rent_cents: leaseRow.rent_cents != null ? leaseRow.rent_cents : null,
    security_deposit_cents:
      leaseRow.security_deposit_cents != null ? leaseRow.security_deposit_cents : null,
    lease_start: leaseRow.lease_start != null ? String(leaseRow.lease_start).slice(0, 10) : null,
    lease_end: leaseRow.lease_end != null ? String(leaseRow.lease_end).slice(0, 10) : null,
    charge_lines: Array.isArray(leaseRow.charge_lines) ? leaseRow.charge_lines : [],
    notes: leaseRow.notes != null ? String(leaseRow.notes).trim() : "",
  };
  return Object.fromEntries(Object.entries(snap).filter(([, v]) => v != null && v !== ""));
}

/**
 * @param {{ property_code?: string, unit_catalog_id?: string, status?: string }} q
 */
async function listUnitOccupancies(q) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db", occupancies: [] };

  const pc = q.property_code != null ? normProp(q.property_code) : "";
  const uid = q.unit_catalog_id != null ? String(q.unit_catalog_id).trim() : "";
  const status = q.status != null ? String(q.status).trim().toLowerCase() : "";

  let chain = sb.from("unit_occupancies").select("*").order("started_at", { ascending: false });
  if (pc) chain = chain.eq("property_code", pc);
  if (uid) chain = chain.eq("unit_catalog_id", uid);
  if (status) chain = chain.eq("status", status);

  const { data, error } = await chain;
  if (error) return { ok: false, error: error.message, occupancies: [] };
  return { ok: true, occupancies: data || [] };
}

/**
 * @param {string} id
 */
async function getUnitOccupancyById(id) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db", occupancy: null };

  const oid = String(id || "").trim();
  if (!oid) return { ok: false, error: "missing_id", occupancy: null };

  const { data, error } = await sb.from("unit_occupancies").select("*").eq("id", oid).maybeSingle();
  if (error) return { ok: false, error: error.message, occupancy: null };
  if (!data) return { ok: false, error: "not_found", occupancy: null };
  return { ok: true, occupancy: data };
}

/**
 * @param {string} unitCatalogId
 */
async function getCurrentUnitOccupancy(unitCatalogId) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db", occupancy: null };

  const uid = String(unitCatalogId || "").trim();
  if (!uid) return { ok: false, error: "missing_unit", occupancy: null };

  const { data, error } = await sb
    .from("unit_occupancies")
    .select("*")
    .eq("unit_catalog_id", uid)
    .eq("status", CURRENT_STATUS)
    .maybeSingle();

  if (error) return { ok: false, error: error.message, occupancy: null };
  if (!data) return { ok: true, occupancy: null };
  return { ok: true, occupancy: data };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {string} tenantRosterId
 * @param {string} propertyCode
 * @param {string} unitLabel
 */
async function validateTenantForUnit(sb, tenantRosterId, propertyCode, unitLabel) {
  const tid = String(tenantRosterId || "").trim();
  if (!tid) return { ok: true, tenant: null };

  const { data: tenant, error } = await sb
    .from("tenant_roster")
    .select("id, property_code, unit_label, resident_name, active")
    .eq("id", tid)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!tenant) return { ok: false, error: "unknown_tenant" };

  if (normProp(tenant.property_code) !== normProp(propertyCode)) {
    return { ok: false, error: "tenant_property_mismatch" };
  }
  if (normUnitLabel(tenant.unit_label) !== normUnitLabel(unitLabel)) {
    return { ok: false, error: "tenant_unit_mismatch" };
  }

  return { ok: true, tenant };
}

/**
 * @param {object} o
 * @param {string} o.property_code
 * @param {string} o.unit_catalog_id
 * @param {string} [o.tenant_roster_id]
 * @param {string} [o.started_at] — ISO timestamp; default now
 * @param {object} [o.lease_snapshot_json]
 * @param {string} [o.created_by]
 * @param {string} [o.traceId]
 */
async function openUnitOccupancy(o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const prop = normProp(o.property_code);
  const unitCatalogId = String(o.unit_catalog_id || "").trim();
  if (!prop || !unitCatalogId) return { ok: false, error: "missing_property_or_unit" };

  const { data: unit, error: uErr } = await sb
    .from("units")
    .select("id, property_code, unit_label")
    .eq("id", unitCatalogId)
    .maybeSingle();
  if (uErr) return { ok: false, error: uErr.message };
  if (!unit) return { ok: false, error: "unknown_unit" };
  if (normProp(unit.property_code) !== prop) return { ok: false, error: "unit_property_mismatch" };

  const unitLabel = normUnitLabel(unit.unit_label);

  const { data: existingCurrent } = await sb
    .from("unit_occupancies")
    .select("id")
    .eq("unit_catalog_id", unitCatalogId)
    .eq("status", CURRENT_STATUS)
    .limit(1)
    .maybeSingle();

  if (existingCurrent) {
    return {
      ok: false,
      error: "active_occupancy_exists",
      existing_occupancy_id: existingCurrent.id,
    };
  }

  const tenantRosterId =
    o.tenant_roster_id != null ? String(o.tenant_roster_id).trim() : "";
  const tenantCheck = await validateTenantForUnit(sb, tenantRosterId, prop, unitLabel);
  if (!tenantCheck.ok) return { ok: false, error: tenantCheck.error };

  let residentName = tenantCheck.tenant
    ? String(tenantCheck.tenant.resident_name || "").trim()
    : "";

  let leaseSnapshot =
    o.lease_snapshot_json && typeof o.lease_snapshot_json === "object"
      ? o.lease_snapshot_json
      : null;

  if (!leaseSnapshot || !Object.keys(leaseSnapshot).length) {
    const { data: leaseRow } = await sb
      .from("unit_leases")
      .select(
        "rent_cents, security_deposit_cents, lease_start, lease_end, charge_lines, notes"
      )
      .eq("unit_catalog_id", unitCatalogId)
      .maybeSingle();
    leaseSnapshot = leaseSnapshotFromRow(leaseRow);
  }

  let startedAt = new Date().toISOString();
  if (o.started_at != null && String(o.started_at).trim()) {
    const parsed = new Date(String(o.started_at).trim());
    if (!Number.isNaN(parsed.getTime())) startedAt = parsed.toISOString();
  } else if (leaseSnapshot.lease_start) {
    const d = new Date(String(leaseSnapshot.lease_start).trim().slice(0, 10) + "T12:00:00.000Z");
    if (!Number.isNaN(d.getTime())) startedAt = d.toISOString();
  }

  const row = {
    unit_catalog_id: unitCatalogId,
    property_code: prop,
    tenant_roster_id: tenantRosterId || null,
    unit_label_snapshot: unitLabel,
    resident_name_snapshot: residentName,
    started_at: startedAt,
    ended_at: null,
    status: CURRENT_STATUS,
    lease_snapshot_json: leaseSnapshot || {},
    created_by: o.created_by != null ? String(o.created_by).trim() : "",
  };

  const { data: inserted, error: insErr } = await sb
    .from("unit_occupancies")
    .insert(row)
    .select("id")
    .maybeSingle();

  if (insErr) return { ok: false, error: insErr.message };

  const occupancyId = inserted && inserted.id ? String(inserted.id) : "";

  await appendEventLog({
    traceId: String(o.traceId || ""),
    log_kind: "portal",
    event: "OCCUPANCY_OPENED",
    payload: {
      occupancy_id: occupancyId,
      unit_catalog_id: unitCatalogId,
      property_code: prop,
      tenant_roster_id: tenantRosterId || null,
    },
  });

  const full = await getUnitOccupancyById(occupancyId);
  return {
    ok: true,
    occupancy_id: occupancyId,
    occupancy: full.occupancy,
  };
}

/**
 * @param {string} occupancyId
 * @param {object} o
 * @param {string} [o.ended_at]
 * @param {string} [o.move_out_turnover_id]
 * @param {string} [o.traceId]
 */
async function closeUnitOccupancy(occupancyId, o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const id = String(occupancyId || "").trim();
  if (!id) return { ok: false, error: "missing_id" };

  const { data: row } = await sb.from("unit_occupancies").select("*").eq("id", id).maybeSingle();
  if (!row) return { ok: false, error: "not_found" };
  if (String(row.status || "").toLowerCase() !== CURRENT_STATUS) {
    return { ok: false, error: "occupancy_not_current" };
  }

  let endedAt = new Date().toISOString();
  if (o && o.ended_at != null && String(o.ended_at).trim()) {
    const parsed = new Date(String(o.ended_at).trim());
    if (!Number.isNaN(parsed.getTime())) endedAt = parsed.toISOString();
  }

  const startedAt = new Date(row.started_at).getTime();
  if (new Date(endedAt).getTime() < startedAt) {
    return { ok: false, error: "ended_before_started" };
  }

  const turnoverId =
    o && o.move_out_turnover_id != null ? String(o.move_out_turnover_id).trim() : "";

  /** @type {Record<string, unknown>} */
  const upd = {
    status: PAST_STATUS,
    ended_at: endedAt,
  };
  if (turnoverId) upd.move_out_turnover_id = turnoverId;

  const { error } = await sb.from("unit_occupancies").update(upd).eq("id", id);
  if (error) return { ok: false, error: error.message };

  await appendEventLog({
    traceId: String((o && o.traceId) || ""),
    log_kind: "portal",
    event: "OCCUPANCY_CLOSED",
    payload: {
      occupancy_id: id,
      unit_catalog_id: row.unit_catalog_id,
      move_out_turnover_id: turnoverId || null,
    },
  });

  return getUnitOccupancyById(id);
}

/**
 * @param {string} occupancyId
 * @param {object} patch
 * @param {object} [o]
 */
async function patchUnitOccupancy(occupancyId, patch, o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const id = String(occupancyId || "").trim();
  if (!id) return { ok: false, error: "missing_id" };

  const { data: existing } = await sb.from("unit_occupancies").select("*").eq("id", id).maybeSingle();
  if (!existing) return { ok: false, error: "not_found" };
  const isPast = String(existing.status || "").toLowerCase() === PAST_STATUS;
  if (isPast) {
    if (patch.move_out_turnover_id === undefined) {
      return { ok: false, error: "occupancy_is_past" };
    }
    const turnoverId =
      patch.move_out_turnover_id != null ? String(patch.move_out_turnover_id).trim() : "";
    const { error } = await sb
      .from("unit_occupancies")
      .update({ move_out_turnover_id: turnoverId || null })
      .eq("id", id);
    if (error) return { ok: false, error: error.message };
    await appendEventLog({
      traceId: String((o && o.traceId) || ""),
      log_kind: "portal",
      event: "OCCUPANCY_PATCHED",
      payload: { occupancy_id: id, keys: ["move_out_turnover_id"], past_link: true },
    });
    return getUnitOccupancyById(id);
  }

  /** @type {Record<string, unknown>} */
  const upd = {};

  if (patch.tenant_roster_id !== undefined) {
    const tid = patch.tenant_roster_id != null ? String(patch.tenant_roster_id).trim() : "";
    const tenantCheck = await validateTenantForUnit(
      sb,
      tid,
      existing.property_code,
      existing.unit_label_snapshot
    );
    if (!tenantCheck.ok) return { ok: false, error: tenantCheck.error };
    upd.tenant_roster_id = tid || null;
    upd.resident_name_snapshot = tenantCheck.tenant
      ? String(tenantCheck.tenant.resident_name || "").trim()
      : "";
  }

  if (patch.lease_snapshot_json !== undefined) {
    upd.lease_snapshot_json =
      patch.lease_snapshot_json && typeof patch.lease_snapshot_json === "object"
        ? patch.lease_snapshot_json
        : {};
  }

  if (patch.started_at !== undefined && String(existing.status || "").toLowerCase() === CURRENT_STATUS) {
    const parsed = new Date(String(patch.started_at || "").trim());
    if (Number.isNaN(parsed.getTime())) return { ok: false, error: "invalid_started_at" };
    upd.started_at = parsed.toISOString();
  }

  if (patch.move_out_turnover_id !== undefined) {
    const tid = patch.move_out_turnover_id != null ? String(patch.move_out_turnover_id).trim() : "";
    upd.move_out_turnover_id = tid || null;
  }

  if (!Object.keys(upd).length) return getUnitOccupancyById(id);

  const { error } = await sb.from("unit_occupancies").update(upd).eq("id", id);
  if (error) return { ok: false, error: error.message };

  await appendEventLog({
    traceId: String((o && o.traceId) || ""),
    log_kind: "portal",
    event: "OCCUPANCY_PATCHED",
    payload: { occupancy_id: id, keys: Object.keys(upd) },
  });

  return getUnitOccupancyById(id);
}

module.exports = {
  leaseSnapshotFromRow,
  listUnitOccupancies,
  getUnitOccupancyById,
  getCurrentUnitOccupancy,
  openUnitOccupancy,
  closeUnitOccupancy,
  patchUnitOccupancy,
};
