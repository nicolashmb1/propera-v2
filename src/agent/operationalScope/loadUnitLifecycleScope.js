/**
 * Unit lifecycle slices for operational scope (occupancy, turnover, assets).
 * Read-only — gated by PROPERA_UNIT_LIFECYCLE_ENABLED.
 * @see docs/UNIT_LIFECYCLE_BUILD_PLAN.md Phase 5
 */

const { getSupabase } = require("../../db/supabase");
const { unitLifecycleEnabled, turnoverEngineEnabled } = require("../../config/env");
const { getCurrentUnitOccupancy } = require("../../dal/unitOccupancies");
const { listTurnovers, getTurnoverById } = require("../../dal/turnovers");
const { listUnitAssets } = require("../../dal/unitAssets");

const ACTIVE_TURNOVER_STATUSES = new Set(["OPEN", "IN_PROGRESS"]);

function normProp(code) {
  return String(code || "")
    .trim()
    .toUpperCase();
}

function normUnitLabel(label) {
  return String(label || "")
    .trim()
    .toLowerCase()
    .replace(/\s/g, "");
}

/**
 * @param {string} propertyCode
 * @param {string} unitLabel
 * @param {string} [hintId]
 */
async function resolveUnitCatalogId(propertyCode, unitLabel, hintId) {
  const hinted = String(hintId || "").trim();
  if (hinted) return hinted;

  const pc = normProp(propertyCode);
  const ul = normUnitLabel(unitLabel);
  if (!pc || !ul) return "";

  const sb = getSupabase();
  if (!sb) return "";

  const { data, error } = await sb
    .from("units")
    .select("id, unit_label")
    .eq("property_code", pc);
  if (error || !data) return "";

  const hit = (Array.isArray(data) ? data : []).find(
    (row) => normUnitLabel(row.unit_label) === ul
  );
  return hit && hit.id ? String(hit.id).trim() : "";
}

/**
 * @param {object} opts
 * @param {string} [opts.propertyCode]
 * @param {string} [opts.unitLabel]
 * @param {string} [opts.unitCatalogId]
 * @param {string} [opts.turnoverId]
 * @returns {Promise<import("./types").OperationalScopeUnitLifecycle | null>}
 */
async function loadUnitLifecycleScope(opts) {
  if (!unitLifecycleEnabled()) return null;

  const o = opts || {};
  const propertyCode = normProp(o.propertyCode);
  const unitLabel = String(o.unitLabel || "").trim();
  const unitCatalogId = await resolveUnitCatalogId(
    propertyCode,
    unitLabel,
    o.unitCatalogId
  );
  if (!unitCatalogId) return null;

  /** @type {import("./types").OperationalScopeUnitLifecycle} */
  const pack = {
    unitCatalogId,
    activeOccupancy: null,
    activeTurnover: null,
    turnoverBlocker: "",
    unitAssets: [],
  };

  const occ = await getCurrentUnitOccupancy(unitCatalogId);
  if (occ.ok && occ.occupancy) {
    const row = occ.occupancy;
    pack.activeOccupancy = {
      occupancyId: String(row.id || "").trim(),
      residentName: String(row.resident_name_snapshot || "").trim(),
      status: String(row.status || "").trim(),
      startedAt: row.started_at != null ? String(row.started_at) : "",
    };
  }

  if (turnoverEngineEnabled()) {
    let activeRow = null;
    const turnoverIdHint = String(o.turnoverId || "").trim();
    if (turnoverIdHint) {
      const byId = await getTurnoverById(turnoverIdHint);
      if (
        byId.ok &&
        byId.turnover &&
        ACTIVE_TURNOVER_STATUSES.has(String(byId.turnover.status || "").trim().toUpperCase())
      ) {
        activeRow = byId.turnover;
      }
    }
    if (!activeRow) {
      const list = await listTurnovers({
        property_code: propertyCode,
        unit_catalog_id: unitCatalogId,
      });
      if (list.ok && Array.isArray(list.turnovers)) {
        activeRow =
          list.turnovers.find((t) =>
            ACTIVE_TURNOVER_STATUSES.has(String(t.status || "").trim().toUpperCase())
          ) || null;
      }
    }
    if (activeRow) {
      pack.activeTurnover = {
        turnoverId: String(activeRow.id || "").trim(),
        status: String(activeRow.status || "").trim(),
        startedAt: activeRow.started_at != null ? String(activeRow.started_at) : "",
        targetReadyDate:
          activeRow.target_ready_date != null ? String(activeRow.target_ready_date).slice(0, 10) : "",
        unitLabel: String(activeRow.unit_label_snapshot || unitLabel || "").trim(),
      };
      pack.turnoverBlocker = String(activeRow.current_blocker || "").trim();
    }
  }

  const assets = await listUnitAssets({
    unit_catalog_id: unitCatalogId,
    status: "active",
  });
  if (assets.ok && Array.isArray(assets.assets)) {
    pack.unitAssets = assets.assets.map((a) => ({
      assetId: String(a.id || "").trim(),
      assetType: String(a.asset_type || "").trim(),
      make: String(a.make || "").trim(),
      model: String(a.model || "").trim(),
      serialNumber: String(a.serial_number || "").trim(),
    }));
  }

  return pack;
}

module.exports = {
  loadUnitLifecycleScope,
  resolveUnitCatalogId,
  normUnitLabel,
};
