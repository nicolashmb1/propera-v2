/**
 * Jarvis reasoning — read the installed-equipment registry for a unit.
 *
 * Bridges natural language ("the dishwasher in 410") to the actual make/model/serial
 * so the loop can then do parts lookup or diagnosis grounded in real equipment.
 *
 * Reuses the existing asset DAL + unit resolver — one source of truth. Read-only,
 * gated by the unit-lifecycle flag (same gate the operational scope uses for assets).
 * @see src/dal/unitAssets.js
 * @see docs/UNIT_LIFECYCLE_BUILD_PLAN.md Phase 3
 */

const { listUnitAssets } = require("../../dal/unitAssets");
const {
  resolveUnitCatalogId,
} = require("../operationalScope/loadUnitLifecycleScope");
const { unitLifecycleEnabled } = require("../../config/env");

// Map casual words to the normalized asset_type used in the registry.
const ASSET_TYPE_SYNONYMS = {
  fridge: "refrigerator",
  refrigerator: "refrigerator",
  freezer: "refrigerator",
  ac: "hvac",
  "a/c": "hvac",
  "air conditioner": "hvac",
  "air conditioning": "hvac",
  heater: "hvac",
  furnace: "hvac",
  dishwasher: "dishwasher",
  washer: "washing_machine",
  "washing machine": "washing_machine",
  dryer: "dryer",
  stove: "range",
  oven: "range",
  range: "range",
  microwave: "microwave",
  "water heater": "water_heater",
};

function lc(s) {
  return String(s || "").trim().toLowerCase();
}

function normType(t) {
  const k = lc(t).replace(/\s+/g, " ");
  return ASSET_TYPE_SYNONYMS[k] || k.replace(/\s+/g, "_");
}

/**
 * @param {object} params — see UNIT_ASSETS_TOOL_SCHEMA
 * @returns {Promise<object>} read-only asset list for a unit
 */
async function getUnitAssets(params) {
  const p = params || {};
  if (!unitLifecycleEnabled()) return { ok: false, error: "assets_not_enabled" };

  const propertyCode = String(p.propertyCode || "").trim().toUpperCase();
  const unitLabel = String(p.unit || p.unitLabel || "").trim();
  const unitCatalogId = String(p.unitCatalogId || "").trim();
  const assetTypeWant = p.assetType ? normType(p.assetType) : "";

  const catId = await resolveUnitCatalogId(propertyCode, unitLabel, unitCatalogId).catch(
    () => ""
  );
  if (!catId) {
    return {
      ok: false,
      error: "unit_not_found",
      propertyCode: propertyCode || null,
      unit: unitLabel || null,
    };
  }

  const res = await listUnitAssets({ unit_catalog_id: catId, status: "active" });
  if (!res.ok) return { ok: false, error: res.error || "lookup_failed" };

  let assets = (res.assets || []).map((a) => ({
    assetId: String(a.id || "").trim(),
    assetType: String(a.asset_type || "").trim(),
    category: String(a.category || "").trim(),
    make: String(a.make || "").trim(),
    model: String(a.model || "").trim(),
    serial: String(a.serial_number || "").trim(),
    installedAt: a.installed_at ? String(a.installed_at).slice(0, 10) : "",
    warrantyEnd: a.warranty_end ? String(a.warranty_end).slice(0, 10) : "",
    hasNameplatePhoto: !!String(a.nameplate_photo_url || "").trim(),
  }));

  if (assetTypeWant) {
    assets = assets.filter((a) => {
      const t = normType(a.assetType);
      return t === assetTypeWant || t.includes(assetTypeWant) || assetTypeWant.includes(t);
    });
  }

  return {
    ok: true,
    unitCatalogId: catId,
    propertyCode: propertyCode || null,
    unit: unitLabel || null,
    assetCount: assets.length,
    assets,
  };
}

/** OpenAI function-calling schema. */
const UNIT_ASSETS_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "get_unit_assets",
    description:
      "List the installed equipment (appliances / HVAC / fixtures) registered for a unit, with " +
      "make, model, and serial number. Read-only. Use this FIRST to turn 'the dishwasher in 410' " +
      "into the actual model before any parts lookup or diagnosis. Returns assets_not_enabled if the " +
      "registry is off, or unit_not_found if the property+unit can't be matched (then confirm them).",
    parameters: {
      type: "object",
      properties: {
        propertyCode: { type: "string", description: "Building code, e.g. PENN." },
        unit: { type: "string", description: "Unit label, e.g. 410." },
        assetType: {
          type: "string",
          description:
            "Optional: filter to one equipment type, e.g. dishwasher, refrigerator (fridge), hvac (ac).",
        },
      },
      additionalProperties: false,
    },
  },
};

module.exports = {
  getUnitAssets,
  UNIT_ASSETS_TOOL_SCHEMA,
};
