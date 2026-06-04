/**
 * Unit assets V1 — installed equipment registry (portal / service role).
 * @see docs/UNIT_LIFECYCLE_BUILD_PLAN.md Phase 3
 */
const { getSupabase } = require("../db/supabase");
const { appendEventLog } = require("./appendEventLog");

const ACTIVE_STATUS = "active";
const VALID_CATEGORIES = new Set(["appliance", "fixture", "hvac", "lock", "other"]);
const VALID_STATUSES = new Set(["active", "removed", "replaced"]);

function normProp(code) {
  return String(code || "").trim().toUpperCase();
}

function normAssetType(t) {
  return String(t || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

/**
 * @param {{ property_code?: string, unit_catalog_id?: string, status?: string }} q
 */
async function listUnitAssets(q) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db", assets: [] };

  const pc = q.property_code != null ? normProp(q.property_code) : "";
  const uid = q.unit_catalog_id != null ? String(q.unit_catalog_id).trim() : "";
  const status = q.status != null ? String(q.status).trim().toLowerCase() : "";

  let chain = sb.from("unit_assets").select("*").order("created_at", { ascending: false });
  if (pc) chain = chain.eq("property_code", pc);
  if (uid) chain = chain.eq("unit_catalog_id", uid);
  if (status) chain = chain.eq("status", status);

  const { data, error } = await chain;
  if (error) return { ok: false, error: error.message, assets: [] };
  return { ok: true, assets: data || [] };
}

/**
 * @param {string} id
 */
async function getUnitAssetById(id) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db", asset: null };

  const aid = String(id || "").trim();
  if (!aid) return { ok: false, error: "missing_id", asset: null };

  const { data, error } = await sb.from("unit_assets").select("*").eq("id", aid).maybeSingle();
  if (error) return { ok: false, error: error.message, asset: null };
  if (!data) return { ok: false, error: "not_found", asset: null };
  return { ok: true, asset: data };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {string} unitCatalogId
 * @param {string} assetType
 * @param {string} [excludeId]
 */
async function findActiveAssetByType(sb, unitCatalogId, assetType, excludeId) {
  const uid = String(unitCatalogId || "").trim();
  const typeNorm = normAssetType(assetType);
  if (!uid || !typeNorm) return null;

  const { data: rows } = await sb
    .from("unit_assets")
    .select("id, asset_type, status")
    .eq("unit_catalog_id", uid)
    .eq("status", ACTIVE_STATUS);

  const list = Array.isArray(rows) ? rows : [];
  return (
    list.find((r) => {
      if (excludeId && String(r.id) === String(excludeId)) return false;
      return normAssetType(r.asset_type) === typeNorm;
    }) || null
  );
}

/**
 * @param {object} o
 */
async function addUnitAsset(o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const prop = normProp(o.property_code);
  const unitCatalogId = String(o.unit_catalog_id || "").trim();
  const assetType = String(o.asset_type || o.assetType || "").trim();
  if (!prop || !unitCatalogId || !assetType) {
    return { ok: false, error: "missing_property_unit_or_type" };
  }

  const { data: unit, error: uErr } = await sb
    .from("units")
    .select("id, property_code, unit_label")
    .eq("id", unitCatalogId)
    .maybeSingle();
  if (uErr) return { ok: false, error: uErr.message };
  if (!unit) return { ok: false, error: "unknown_unit" };
  if (normProp(unit.property_code) !== prop) return { ok: false, error: "unit_property_mismatch" };

  const dup = await findActiveAssetByType(sb, unitCatalogId, assetType);
  if (dup) {
    return {
      ok: false,
      error: "active_asset_type_exists",
      existing_asset_id: dup.id,
    };
  }

  const categoryRaw = String(o.category || "appliance").trim().toLowerCase();
  const category = VALID_CATEGORIES.has(categoryRaw) ? categoryRaw : "appliance";

  const row = {
    unit_catalog_id: unitCatalogId,
    property_code: prop,
    unit_label_snapshot: String(unit.unit_label || "").trim(),
    category,
    asset_type: assetType,
    make: o.make != null ? String(o.make).trim() : "",
    model: o.model != null ? String(o.model).trim() : "",
    serial_number: o.serial_number != null ? String(o.serial_number).trim() : "",
    installed_at:
      o.installed_at != null && String(o.installed_at).trim()
        ? String(o.installed_at).trim().slice(0, 10)
        : null,
    installed_by: o.installed_by != null ? String(o.installed_by).trim() : "",
    warranty_start:
      o.warranty_start != null && String(o.warranty_start).trim()
        ? String(o.warranty_start).trim().slice(0, 10)
        : null,
    warranty_end:
      o.warranty_end != null && String(o.warranty_end).trim()
        ? String(o.warranty_end).trim().slice(0, 10)
        : null,
    status: ACTIVE_STATUS,
    nameplate_photo_url:
      o.nameplate_photo_url != null ? String(o.nameplate_photo_url).trim() : "",
    source_ticket_id: o.source_ticket_id != null ? String(o.source_ticket_id).trim() : "",
    source_turnover_id:
      o.source_turnover_id != null ? String(o.source_turnover_id).trim() : null,
    metadata_json:
      o.metadata_json && typeof o.metadata_json === "object" ? o.metadata_json : {},
    created_by: o.created_by != null ? String(o.created_by).trim() : "",
  };

  const { data: inserted, error: insErr } = await sb
    .from("unit_assets")
    .insert(row)
    .select("id")
    .maybeSingle();
  if (insErr) return { ok: false, error: insErr.message };

  const assetId = inserted && inserted.id ? String(inserted.id) : "";

  await appendEventLog({
    traceId: String(o.traceId || ""),
    log_kind: "portal",
    event: "UNIT_ASSET_ADDED",
    payload: { asset_id: assetId, unit_catalog_id: unitCatalogId, asset_type: assetType },
  });

  return getUnitAssetById(assetId);
}

/**
 * @param {string} assetId
 * @param {object} patch
 * @param {object} [o]
 */
async function updateUnitAsset(assetId, patch, o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const id = String(assetId || "").trim();
  if (!id) return { ok: false, error: "missing_id" };

  const { data: existing } = await sb.from("unit_assets").select("*").eq("id", id).maybeSingle();
  if (!existing) return { ok: false, error: "not_found" };
  if (String(existing.status || "") !== ACTIVE_STATUS) {
    return { ok: false, error: "asset_not_active" };
  }

  /** @type {Record<string, unknown>} */
  const upd = {};

  if (patch.category !== undefined) {
    const c = String(patch.category || "").trim().toLowerCase();
    upd.category = VALID_CATEGORIES.has(c) ? c : existing.category;
  }
  if (patch.asset_type !== undefined) {
    const t = String(patch.asset_type || "").trim();
    if (!t) return { ok: false, error: "missing_asset_type" };
    const dup = await findActiveAssetByType(sb, existing.unit_catalog_id, t, id);
    if (dup) return { ok: false, error: "active_asset_type_exists", existing_asset_id: dup.id };
    upd.asset_type = t;
  }
  if (patch.make !== undefined) upd.make = String(patch.make || "").trim();
  if (patch.model !== undefined) upd.model = String(patch.model || "").trim();
  if (patch.serial_number !== undefined) upd.serial_number = String(patch.serial_number || "").trim();
  if (patch.installed_at !== undefined) {
    upd.installed_at =
      patch.installed_at != null && String(patch.installed_at).trim()
        ? String(patch.installed_at).trim().slice(0, 10)
        : null;
  }
  if (patch.installed_by !== undefined) upd.installed_by = String(patch.installed_by || "").trim();
  if (patch.warranty_start !== undefined) {
    upd.warranty_start =
      patch.warranty_start != null && String(patch.warranty_start).trim()
        ? String(patch.warranty_start).trim().slice(0, 10)
        : null;
  }
  if (patch.warranty_end !== undefined) {
    upd.warranty_end =
      patch.warranty_end != null && String(patch.warranty_end).trim()
        ? String(patch.warranty_end).trim().slice(0, 10)
        : null;
  }
  if (patch.nameplate_photo_url !== undefined) {
    upd.nameplate_photo_url = String(patch.nameplate_photo_url || "").trim();
  }
  if (patch.metadata_json !== undefined) {
    upd.metadata_json =
      patch.metadata_json && typeof patch.metadata_json === "object" ? patch.metadata_json : {};
  }

  if (!Object.keys(upd).length) return getUnitAssetById(id);

  const { error } = await sb.from("unit_assets").update(upd).eq("id", id);
  if (error) return { ok: false, error: error.message };

  await appendEventLog({
    traceId: String((o && o.traceId) || ""),
    log_kind: "portal",
    event: "UNIT_ASSET_UPDATED",
    payload: { asset_id: id, keys: Object.keys(upd) },
  });

  return getUnitAssetById(id);
}

/**
 * @param {string} assetId
 * @param {'removed'|'replaced'} status
 * @param {object} [o]
 */
async function markUnitAssetInactive(assetId, status, o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const id = String(assetId || "").trim();
  const st = String(status || "").trim().toLowerCase();
  if (!id) return { ok: false, error: "missing_id" };
  if (!VALID_STATUSES.has(st) || st === ACTIVE_STATUS) {
    return { ok: false, error: "invalid_status" };
  }

  const { data: existing } = await sb.from("unit_assets").select("id, status").eq("id", id).maybeSingle();
  if (!existing) return { ok: false, error: "not_found" };
  if (String(existing.status || "") !== ACTIVE_STATUS) {
    return { ok: false, error: "asset_not_active" };
  }

  const { error } = await sb.from("unit_assets").update({ status: st }).eq("id", id);
  if (error) return { ok: false, error: error.message };

  await appendEventLog({
    traceId: String((o && o.traceId) || ""),
    log_kind: "portal",
    event: "UNIT_ASSET_MARKED_INACTIVE",
    payload: { asset_id: id, status: st },
  });

  return getUnitAssetById(id);
}

/**
 * Replace active asset: mark old replaced, insert new row linked via replaced_by_id on old row.
 * @param {string} assetId
 * @param {object} newAssetBody
 * @param {object} [o]
 */
async function replaceUnitAsset(assetId, newAssetBody, o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const id = String(assetId || "").trim();
  if (!id) return { ok: false, error: "missing_id" };

  const { data: existing } = await sb.from("unit_assets").select("*").eq("id", id).maybeSingle();
  if (!existing) return { ok: false, error: "not_found" };
  if (String(existing.status || "") !== ACTIVE_STATUS) {
    return { ok: false, error: "asset_not_active" };
  }

  const body = newAssetBody || {};
  const assetType = String(body.asset_type || body.assetType || existing.asset_type || "").trim();
  if (!assetType) return { ok: false, error: "missing_asset_type" };

  const { error: markErr } = await sb
    .from("unit_assets")
    .update({ status: "replaced" })
    .eq("id", id);
  if (markErr) return { ok: false, error: markErr.message };

  const added = await addUnitAsset({
    property_code: existing.property_code,
    unit_catalog_id: existing.unit_catalog_id,
    category: body.category || existing.category,
    asset_type: assetType,
    make: body.make != null ? body.make : existing.make,
    model: body.model != null ? body.model : "",
    serial_number: body.serial_number != null ? body.serial_number : "",
    installed_at: body.installed_at != null ? body.installed_at : new Date().toISOString().slice(0, 10),
    installed_by: body.installed_by != null ? body.installed_by : "",
    warranty_start: body.warranty_start,
    warranty_end: body.warranty_end,
    nameplate_photo_url: body.nameplate_photo_url,
    source_ticket_id: body.source_ticket_id,
    source_turnover_id: body.source_turnover_id,
    metadata_json: body.metadata_json,
    created_by: body.created_by,
    traceId: o && o.traceId,
  });

  if (!added.ok || !added.asset) {
    return added;
  }

  const newId = String(added.asset.id || "");

  await sb.from("unit_assets").update({ replaced_by_id: newId }).eq("id", id);

  await appendEventLog({
    traceId: String((o && o.traceId) || ""),
    log_kind: "portal",
    event: "UNIT_ASSET_REPLACED",
    payload: { old_asset_id: id, new_asset_id: newId },
  });

  return { ok: true, asset: added.asset, replaced_asset_id: id };
}

module.exports = {
  normAssetType,
  listUnitAssets,
  getUnitAssetById,
  addUnitAsset,
  updateUnitAsset,
  markUnitAssetInactive,
  replaceUnitAsset,
};
