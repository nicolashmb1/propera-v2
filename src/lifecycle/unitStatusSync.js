/**
 * Sync V4 — align units.status with occupancy open/close; DB trigger writes unit_status_history (064).
 * @see docs/ENGINE_CONNECTIVITY_REVIEW.md
 */
const { getSupabase } = require("../db/supabase");
const { unitLifecycleEnabled } = require("../config/env");
const { appendEventLog } = require("../dal/appendEventLog");

const STATUS_OCCUPIED = "Occupied";
const STATUS_VACANT = "Vacant";
const STATUS_NOTICE = "Notice";

/** Statuses we do not overwrite from occupancy automation. */
const PROTECTED_STATUSES = new Set(["down", "model"]);

function normStatus(s) {
  return String(s || "").trim();
}

function isProtected(status) {
  return PROTECTED_STATUSES.has(normStatus(status).toLowerCase());
}

function unitStatusSyncEnabled() {
  return unitLifecycleEnabled();
}

/**
 * @param {string} unitCatalogId
 * @param {string} status
 * @param {object} [o]
 * @param {string} [o.traceId]
 * @param {string} [o.at] — ISO timestamp for updated_at (vacancy/occupy timing)
 */
async function applyUnitCatalogStatus(unitCatalogId, status, o) {
  if (!unitStatusSyncEnabled()) {
    return { ok: true, skipped: "lifecycle_disabled" };
  }

  const uid = String(unitCatalogId || "").trim();
  const target = normStatus(status);
  if (!uid || !target) return { ok: false, error: "missing_unit_or_status" };

  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const { data: unit, error: loadErr } = await sb
    .from("units")
    .select("id, status, property_code")
    .eq("id", uid)
    .maybeSingle();

  if (loadErr) return { ok: false, error: loadErr.message };
  if (!unit) return { ok: false, error: "unit_not_found" };

  const current = normStatus(unit.status);
  if (isProtected(current)) {
    return { ok: true, skipped: "protected_status", previous_status: current };
  }
  if (current.toLowerCase() === target.toLowerCase()) {
    return { ok: true, skipped: "already_set", unit_status: current };
  }

  let updatedAt = new Date().toISOString();
  if (o && o.at != null && String(o.at).trim()) {
    const parsed = new Date(String(o.at).trim());
    if (!Number.isNaN(parsed.getTime())) updatedAt = parsed.toISOString();
  }

  const { error: updErr } = await sb
    .from("units")
    .update({ status: target, updated_at: updatedAt })
    .eq("id", uid);

  if (updErr) return { ok: false, error: updErr.message };

  await appendEventLog({
    traceId: String((o && o.traceId) || ""),
    log_kind: "portal",
    event: "UNIT_LIFECYCLE_SYNC_UNIT_STATUS",
    payload: {
      unit_catalog_id: uid,
      property_code: unit.property_code,
      from_status: current,
      to_status: target,
      at: updatedAt,
    },
  });

  return { ok: true, unit_status: target, previous_status: current };
}

/**
 * @param {object} occupancy — row with unit_catalog_id, started_at
 * @param {object} [o]
 */
async function syncUnitStatusOnOccupancyOpen(occupancy, o) {
  if (!occupancy) return { ok: true, skipped: "no_occupancy" };
  return applyUnitCatalogStatus(occupancy.unit_catalog_id, STATUS_OCCUPIED, {
    traceId: o && o.traceId,
    at: occupancy.started_at,
  });
}

/**
 * @param {object} occupancy — row with unit_catalog_id, ended_at
 * @param {object} [o]
 * @param {string} [o.unitStatus] — default Vacant; Notice for lease vacating
 */
async function syncUnitStatusOnOccupancyClose(occupancy, o) {
  if (!occupancy) return { ok: true, skipped: "no_occupancy" };
  const status =
    o && o.unitStatus != null ? normStatus(o.unitStatus) : STATUS_VACANT;
  return applyUnitCatalogStatus(occupancy.unit_catalog_id, status, {
    traceId: o && o.traceId,
    at: occupancy.ended_at,
  });
}

module.exports = {
  STATUS_OCCUPIED,
  STATUS_VACANT,
  STATUS_NOTICE,
  applyUnitCatalogStatus,
  syncUnitStatusOnOccupancyOpen,
  syncUnitStatusOnOccupancyClose,
};
