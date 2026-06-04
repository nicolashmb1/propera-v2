/**
 * Unit lifecycle orchestrator — cross-engine sync at portal write boundary.
 * Keeps tenant_roster, unit_occupancies, turnovers, and leasing intent aligned.
 * @see docs/ENGINE_CONNECTIVITY_REVIEW.md
 */
const { getSupabase } = require("../db/supabase");
const { unitLifecycleEnabled, turnoverEngineEnabled } = require("../config/env");
const {
  closeUnitOccupancy,
  getCurrentUnitOccupancy,
  getUnitOccupancyById,
  openUnitOccupancy,
  patchUnitOccupancy,
  leaseSnapshotFromRow,
} = require("../dal/unitOccupancies");
const { createTenantForPortal, updateTenantForPortal } = require("../dal/portalTenants");
const { startTurnover } = require("../dal/turnovers");
const { appendEventLog } = require("../dal/appendEventLog");
const {
  STATUS_NOTICE,
  syncUnitStatusOnOccupancyOpen,
  syncUnitStatusOnOccupancyClose,
} = require("./unitStatusSync");
const { normalizePhoneE164, rosterPhoneLookupCandidates } = require("../utils/phone");
const { normalizeUnit_ } = require("../brain/shared/extractUnitGas");

function normProp(code) {
  return String(code || "")
    .trim()
    .toUpperCase();
}

/**
 * @param {string} tenantRosterId
 * @param {object} [o]
 */
async function syncAfterTenantDeactivated(tenantRosterId, o) {
  if (!unitLifecycleEnabled()) {
    return { ok: true, skipped: "lifecycle_disabled" };
  }

  const tid = String(tenantRosterId || "").trim();
  if (!tid) return { ok: false, error: "missing_tenant_id" };

  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const { data: tenant, error: tErr } = await sb
    .from("tenant_roster")
    .select("id, property_code, unit_label")
    .eq("id", tid)
    .maybeSingle();
  if (tErr) return { ok: false, error: tErr.message };
  if (!tenant) return { ok: false, error: "tenant_not_found" };

  const { data: unit } = await sb
    .from("units")
    .select("id")
    .eq("property_code", normProp(tenant.property_code))
    .eq("unit_label", String(tenant.unit_label || "").trim())
    .maybeSingle();

  if (!unit || !unit.id) {
    return { ok: true, skipped: "unit_not_in_catalog" };
  }

  const current = await getCurrentUnitOccupancy(unit.id);
  if (!current.ok) return { ok: false, error: current.error || "occupancy_lookup_failed" };
  if (!current.occupancy) {
    return { ok: true, skipped: "no_current_occupancy" };
  }

  const occTenant = String(current.occupancy.tenant_roster_id || "").trim();
  if (occTenant && occTenant !== tid) {
    return { ok: true, skipped: "current_occupancy_other_tenant" };
  }

  const closed = await closeUnitOccupancy(current.occupancy.id, {
    traceId: String((o && o.traceId) || ""),
  });
  if (!closed.ok) return closed;

  const unitStatusSync = await syncUnitStatusOnOccupancyClose(closed.occupancy, {
    traceId: String((o && o.traceId) || ""),
  });

  await appendEventLog({
    traceId: String((o && o.traceId) || ""),
    log_kind: "portal",
    event: "UNIT_LIFECYCLE_SYNC_TENANT_DEACTIVATED",
    payload: {
      tenant_roster_id: tid,
      occupancy_id: current.occupancy.id,
      unit_catalog_id: unit.id,
    },
  });

  return {
    ok: true,
    occupancy: closed.occupancy,
    action: "occupancy_closed",
    unit_status_sync: unitStatusSync,
  };
}

/**
 * @param {object} leaseRow — patched lease with unit_catalog_id, property_code
 * @param {object} [o]
 */
async function syncAfterLeaseMarkedVacating(leaseRow, o) {
  if (!unitLifecycleEnabled()) {
    return { ok: true, skipped: "lifecycle_disabled" };
  }

  const renewalStatus = String(leaseRow?.renewal_status || "").trim().toLowerCase();
  if (renewalStatus !== "vacating") {
    return { ok: true, skipped: "not_vacating" };
  }

  const unitCatalogId = String(leaseRow?.unit_catalog_id || "").trim();
  if (!unitCatalogId) {
    return { ok: true, skipped: "lease_has_no_unit_catalog_id" };
  }

  const current = await getCurrentUnitOccupancy(unitCatalogId);
  if (!current.ok) return { ok: false, error: current.error || "occupancy_lookup_failed" };
  if (!current.occupancy) {
    return { ok: true, skipped: "no_current_occupancy" };
  }

  const closed = await closeUnitOccupancy(current.occupancy.id, {
    traceId: String((o && o.traceId) || ""),
  });
  if (!closed.ok) return closed;

  const unitStatusSync = await syncUnitStatusOnOccupancyClose(closed.occupancy, {
    traceId: String((o && o.traceId) || ""),
    unitStatus: STATUS_NOTICE,
  });

  await appendEventLog({
    traceId: String((o && o.traceId) || ""),
    log_kind: "portal",
    event: "UNIT_LIFECYCLE_SYNC_LEASE_VACATING",
    payload: {
      lease_id: String(leaseRow?.id || ""),
      occupancy_id: current.occupancy.id,
      unit_catalog_id: unitCatalogId,
    },
  });

  return {
    ok: true,
    occupancy: closed.occupancy,
    action: "occupancy_closed",
    unit_status_sync: unitStatusSync,
  };
}

/**
 * @param {string} occupancyId
 * @param {object} [o]
 * @param {string} [o.ended_at]
 * @param {string} [o.move_out_turnover_id]
 * @param {boolean} [o.start_turnover]
 */
async function closeOccupancyWithOptions(occupancyId, o) {
  if (!unitLifecycleEnabled()) {
    return { ok: false, error: "unit_lifecycle_disabled" };
  }

  const id = String(occupancyId || "").trim();
  if (!id) return { ok: false, error: "missing_occupancy_id" };

  const body = o || {};
  let moveOutTurnoverId =
    body.move_out_turnover_id != null ? String(body.move_out_turnover_id).trim() : "";

  if (!moveOutTurnoverId && body.start_turnover && turnoverEngineEnabled()) {
    const loaded = await getUnitOccupancyById(id);
    if (loaded.ok && loaded.occupancy) {
      const occ = loaded.occupancy;
      const started = await startTurnover({
        property_code: occ.property_code,
        unit_catalog_id: occ.unit_catalog_id,
        traceId: String(body.traceId || ""),
      });
      if (started.ok && started.turnover_id) {
        moveOutTurnoverId = String(started.turnover_id);
      }
    }
  }

  const closed = await closeUnitOccupancy(id, {
    ended_at: body.ended_at ?? body.endedAt,
    move_out_turnover_id: moveOutTurnoverId || undefined,
    traceId: String(body.traceId || ""),
  });
  if (!closed.ok) return closed;

  const unitStatusSync = await syncUnitStatusOnOccupancyClose(closed.occupancy, {
    traceId: String(body.traceId || ""),
  });

  await appendEventLog({
    traceId: String(body.traceId || ""),
    log_kind: "portal",
    event: "UNIT_LIFECYCLE_SYNC_OCCUPANCY_CLOSED",
    payload: {
      occupancy_id: id,
      move_out_turnover_id: moveOutTurnoverId || null,
      turnover_started: !!(body.start_turnover && moveOutTurnoverId),
      unit_status: unitStatusSync.unit_status || unitStatusSync.skipped || null,
    },
  });

  return {
    ok: true,
    occupancy: closed.occupancy,
    turnover_id: moveOutTurnoverId || null,
    turnover_started: !!(body.start_turnover && moveOutTurnoverId),
    unit_status_sync: unitStatusSync,
  };
}

function defaultLeaseEndFromStart(leaseStartYmd) {
  const start = String(leaseStartYmd || "").trim().slice(0, 10);
  if (!start) return null;
  const d = new Date(`${start}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {object} prospect
 * @param {object} [syncLease] — optional explicit terms from portal body
 */
function leaseTermsFromProspect(prospect, syncLease) {
  if (syncLease && typeof syncLease === "object") {
    const rent =
      syncLease.rent_cents != null ? Math.max(0, Math.round(Number(syncLease.rent_cents))) : null;
    const deposit =
      syncLease.security_deposit_cents != null
        ? Math.max(0, Math.round(Number(syncLease.security_deposit_cents)))
        : null;
    const leaseStart =
      typeof syncLease.lease_start === "string" && syncLease.lease_start
        ? syncLease.lease_start.slice(0, 10)
        : null;
    let leaseEnd =
      typeof syncLease.lease_end === "string" && syncLease.lease_end
        ? syncLease.lease_end.slice(0, 10)
        : null;
    if (leaseStart && !leaseEnd) leaseEnd = defaultLeaseEndFromStart(leaseStart);
    return {
      rent_cents: rent,
      security_deposit_cents: deposit != null ? deposit : rent,
      lease_start: leaseStart,
      lease_end: leaseEnd,
      charge_lines: Array.isArray(syncLease.charge_lines) ? syncLease.charge_lines : [],
      notes: syncLease.notes != null ? String(syncLease.notes).trim() : "",
    };
  }

  const rent =
    prospect.budget_max_cents != null
      ? prospect.budget_max_cents
      : prospect.budget_min_cents != null
        ? prospect.budget_min_cents
        : null;
  const leaseStart = prospect.target_move_in
    ? String(prospect.target_move_in).slice(0, 10)
    : null;
  const leaseEnd = leaseStart ? defaultLeaseEndFromStart(leaseStart) : null;
  const notes = String(prospect.notes || "").trim();
  return {
    rent_cents: rent,
    security_deposit_cents: rent,
    lease_start: leaseStart,
    lease_end: leaseEnd,
    charge_lines: [],
    notes: notes ? `From leasing prospect: ${notes}`.slice(0, 2000) : "",
  };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {object} o
 */
async function findOrActivateTenantForUnit(sb, o) {
  const prop = normProp(o.property_code);
  const unitLabel = normalizeUnit_(String(o.unit_label || ""));
  const phoneRaw = normalizePhoneE164(String(o.phone || ""));
  if (!phoneRaw || phoneRaw.length < 8) {
    return { ok: false, error: "prospect_missing_phone" };
  }

  const candidates = rosterPhoneLookupCandidates(o.phone);
  const { data: rows } = await sb
    .from("tenant_roster")
    .select("id, property_code, unit_label, active, phone_e164")
    .eq("property_code", prop)
    .eq("unit_label", unitLabel)
    .in("phone_e164", candidates.length ? candidates : [phoneRaw]);

  const hit = (rows || []).find((r) => candidates.includes(String(r.phone_e164 || "")));
  if (hit) {
    if (hit.active === false) {
      const upd = await updateTenantForPortal(hit.id, {
        active: true,
        name: o.name,
        email: o.email,
        notes: o.notes,
      });
      if (!upd.ok) return upd;
      return { ok: true, tenant_id: hit.id, action: "tenant_reactivated" };
    }
    return { ok: true, tenant_id: hit.id, action: "tenant_exists" };
  }

  const created = await createTenantForPortal({
    propertyCode: prop,
    unit: unitLabel,
    name: o.name,
    phone: o.phone,
    email: o.email,
    notes: o.notes,
    active: true,
  });
  if (!created.ok) return created;
  return {
    ok: true,
    tenant_id: String(created.tenant.id || ""),
    action: "tenant_created",
  };
}

/**
 * @param {string} unitCatalogId
 * @param {string} propertyCode
 * @param {object} terms
 */
async function upsertUnitLeaseForMoveIn(unitCatalogId, propertyCode, terms) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const uid = String(unitCatalogId || "").trim();
  const prop = normProp(propertyCode);
  if (!uid || !prop) return { ok: false, error: "missing_unit_or_property" };

  const { data: existing } = await sb
    .from("unit_leases")
    .select("renewal_status, renewal_notes")
    .eq("unit_catalog_id", uid)
    .maybeSingle();

  const row = {
    unit_catalog_id: uid,
    property_code: prop,
    rent_cents: terms.rent_cents,
    security_deposit_cents: terms.security_deposit_cents,
    lease_start: terms.lease_start,
    lease_end: terms.lease_end,
    charge_lines: terms.charge_lines || [],
    notes: terms.notes || "",
    renewal_status: existing?.renewal_status || "pending",
    renewal_notes: existing?.renewal_notes || "",
  };

  const { data, error } = await sb
    .from("unit_leases")
    .upsert(row, { onConflict: "unit_catalog_id" })
    .select("*")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  return { ok: true, lease: data };
}

/**
 * Prospect marked signed — roster + lease + occupancy (when lifecycle on).
 * @param {object} prospect — patched row
 * @param {object} [o]
 * @param {object} [o.sync_lease]
 * @param {string} [o.traceId]
 */
async function syncAfterProspectSigned(prospect, o) {
  const body = o || {};
  const traceId = String(body.traceId || "");

  const unitCatalogId = String(prospect?.unit_catalog_id || "").trim();
  const propertyCode = normProp(prospect?.property_code);
  if (!propertyCode) {
    return { ok: false, error: "prospect_missing_property" };
  }
  if (!unitCatalogId) {
    return { ok: true, skipped: "prospect_missing_unit" };
  }

  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const { data: unit, error: uErr } = await sb
    .from("units")
    .select("id, property_code, unit_label")
    .eq("id", unitCatalogId)
    .maybeSingle();
  if (uErr) return { ok: false, error: uErr.message };
  if (!unit) return { ok: false, error: "unit_not_found" };
  if (normProp(unit.property_code) !== propertyCode) {
    return { ok: false, error: "unit_property_mismatch" };
  }

  const tenantOut = await findOrActivateTenantForUnit(sb, {
    property_code: propertyCode,
    unit_label: unit.unit_label,
    name: prospect.name,
    phone: prospect.phone,
    email: prospect.email,
    notes: prospect.notes,
  });
  if (!tenantOut.ok) return tenantOut;

  const terms = leaseTermsFromProspect(prospect, body.sync_lease);
  const leaseOut = await upsertUnitLeaseForMoveIn(unitCatalogId, propertyCode, terms);
  if (!leaseOut.ok) return leaseOut;

  /** @type {Record<string, unknown>} */
  const result = {
    ok: true,
    tenant_id: tenantOut.tenant_id,
    tenant_action: tenantOut.action,
    lease: leaseOut.lease,
  };

  if (!unitLifecycleEnabled()) {
    result.skipped_occupancy = "lifecycle_disabled";
    await appendEventLog({
      traceId,
      log_kind: "portal",
      event: "UNIT_LIFECYCLE_SYNC_PROSPECT_SIGNED",
      payload: { prospect_id: prospect.id, unit_catalog_id: unitCatalogId, ...result },
    });
    return result;
  }

  const current = await getCurrentUnitOccupancy(unitCatalogId);
  if (!current.ok) return { ok: false, error: current.error || "occupancy_lookup_failed" };

  const snap = leaseSnapshotFromRow(leaseOut.lease);
  const startedAt = terms.lease_start
    ? `${terms.lease_start}T12:00:00.000Z`
    : undefined;

  if (current.occupancy) {
    const occTenant = String(current.occupancy.tenant_roster_id || "").trim();
    if (occTenant && occTenant !== tenantOut.tenant_id) {
      result.skipped_occupancy = "current_occupancy_other_tenant";
    } else {
      const patched = await patchUnitOccupancy(current.occupancy.id, {
        tenant_roster_id: tenantOut.tenant_id,
        lease_snapshot_json: snap,
      });
      if (!patched.ok) return patched;
      result.occupancy = patched.occupancy;
      result.occupancy_action = "occupancy_snapshot_refreshed";
    }
  } else {
    const opened = await openUnitOccupancy({
      property_code: propertyCode,
      unit_catalog_id: unitCatalogId,
      tenant_roster_id: tenantOut.tenant_id,
      started_at: startedAt,
      lease_snapshot_json: snap,
      traceId,
    });
    if (!opened.ok) {
      if (opened.error === "active_occupancy_exists") {
        result.skipped_occupancy = "active_occupancy_exists";
      } else {
        return opened;
      }
    } else {
      result.occupancy = opened.occupancy;
      result.occupancy_action = "occupancy_opened";
      result.unit_status_sync = await syncUnitStatusOnOccupancyOpen(opened.occupancy, { traceId });
    }
  }

  if (result.occupancy && result.occupancy_action === "occupancy_snapshot_refreshed") {
    result.unit_status_sync = await syncUnitStatusOnOccupancyOpen(result.occupancy, { traceId });
  }

  await appendEventLog({
    traceId,
    log_kind: "portal",
    event: "UNIT_LIFECYCLE_SYNC_PROSPECT_SIGNED",
    payload: {
      prospect_id: String(prospect.id || ""),
      unit_catalog_id: unitCatalogId,
      tenant_id: tenantOut.tenant_id,
      occupancy_action: result.occupancy_action || result.skipped_occupancy || null,
    },
  });

  return result;
}

/**
 * @param {object} openInput — openUnitOccupancy args
 */
async function openOccupancyWithSync(openInput) {
  const input = openInput || {};
  const traceId = String(input.traceId || "");
  const tenantId =
    input.tenant_roster_id != null ? String(input.tenant_roster_id).trim() : "";

  if (tenantId) {
    const activated = await updateTenantForPortal(tenantId, { active: true });
    if (!activated.ok && activated.error !== "no_updates") {
      return { ok: false, error: activated.error || "tenant_activate_failed" };
    }
  }

  const opened = await openUnitOccupancy(input);
  if (!opened.ok) return opened;

  const unitStatusSync = await syncUnitStatusOnOccupancyOpen(opened.occupancy, { traceId });

  await appendEventLog({
    traceId,
    log_kind: "portal",
    event: "UNIT_LIFECYCLE_SYNC_OCCUPANCY_OPENED",
    payload: {
      occupancy_id: opened.occupancy_id,
      tenant_roster_id: tenantId || null,
      unit_catalog_id: input.unit_catalog_id,
      unit_status: unitStatusSync.unit_status || unitStatusSync.skipped || null,
    },
  });

  return {
    ok: true,
    occupancy_id: opened.occupancy_id,
    occupancy: opened.occupancy,
    tenant_activated: !!tenantId,
    unit_status_sync: unitStatusSync,
  };
}

/**
 * Copy current unit_leases row onto current occupancy snapshot.
 * @param {string} unitCatalogId
 * @param {object} [o]
 */
async function syncLeaseSnapshotToCurrentOccupancy(unitCatalogId, o) {
  if (!unitLifecycleEnabled()) {
    return { ok: true, skipped: "lifecycle_disabled" };
  }

  const uid = String(unitCatalogId || "").trim();
  if (!uid) return { ok: false, error: "missing_unit" };

  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const { data: leaseRow } = await sb
    .from("unit_leases")
    .select("rent_cents, security_deposit_cents, lease_start, lease_end, charge_lines, notes")
    .eq("unit_catalog_id", uid)
    .maybeSingle();

  if (!leaseRow) {
    return { ok: true, skipped: "no_lease_on_unit" };
  }

  const current = await getCurrentUnitOccupancy(uid);
  if (!current.ok) return { ok: false, error: current.error || "occupancy_lookup_failed" };
  if (!current.occupancy) {
    return { ok: true, skipped: "no_current_occupancy" };
  }

  const patched = await patchUnitOccupancy(current.occupancy.id, {
    lease_snapshot_json: leaseSnapshotFromRow(leaseRow),
  });
  if (!patched.ok) return patched;

  await appendEventLog({
    traceId: String((o && o.traceId) || ""),
    log_kind: "portal",
    event: "UNIT_LIFECYCLE_SYNC_LEASE_SNAPSHOT",
    payload: {
      unit_catalog_id: uid,
      occupancy_id: current.occupancy.id,
    },
  });

  return { ok: true, occupancy: patched.occupancy, action: "lease_snapshot_refreshed" };
}

module.exports = {
  syncAfterTenantDeactivated,
  syncAfterLeaseMarkedVacating,
  closeOccupancyWithOptions,
  syncAfterProspectSigned,
  openOccupancyWithSync,
  syncLeaseSnapshotToCurrentOccupancy,
  leaseTermsFromProspect,
};
