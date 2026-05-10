/**
 * Canonical maintenance location resolution — structured portal, NL draft hints, optional units catalog.
 * Deterministic; DB touches only `public.units` when catalog IDs/labels are provided.
 */

"use strict";

const {
  normalizeLocationType,
  isCommonAreaLocation,
  resolveMaintenanceDraftLocationType,
} = require("../shared/commonArea");
const { getActivePropertyLocationById } = require("../../dal/propertyLocations");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(s) {
  return typeof s === "string" && UUID_RE.test(String(s).trim());
}

function normalizeTargetKindFromPortal(raw) {
  const t = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (t === "common_area" || t === "commonarea") return "common_area";
  if (t === "property" || t === "building") return "property";
  return "unit";
}

/**
 * @param {object | null} sb
 * @param {string} propertyCodeUpper
 * @param {string} unitCatalogId
 * @returns {Promise<object | null>}
 */
async function fetchUnitById(sb, propertyCodeUpper, unitCatalogId) {
  if (!sb || !isUuid(unitCatalogId)) return null;
  const id = String(unitCatalogId).trim();
  let data;
  let error;
  try {
    const r = await sb
      .from("units")
      .select("id, unit_label, property_code")
      .eq("id", id)
      .maybeSingle();
    data = r.data;
    error = r.error;
  } catch (_) {
    return null;
  }
  if (error || !data) return null;
  const pc = String(data.property_code || "").trim().toUpperCase();
  const want = String(propertyCodeUpper || "").trim().toUpperCase();
  if (want && pc !== want) return null;
  return data;
}

/**
 * @param {object | null} sb
 * @param {string} propertyCodeUpper
 * @param {string} unitLabel
 * @returns {Promise<{ row: object | null, ambiguous: boolean }>}
 */
async function fetchUnitByLabel(sb, propertyCodeUpper, unitLabel) {
  const ul = String(unitLabel || "").trim();
  const prop = String(propertyCodeUpper || "").trim().toUpperCase();
  if (!sb || !ul) return { row: null, ambiguous: false };

  let rows = null;
  let error = null;
  try {
    const r = await sb
      .from("units")
      .select("id, unit_label, property_code")
      .eq("property_code", prop)
      .eq("unit_label", ul);
    rows = r.data;
    error = r.error;
  } catch (e) {
    return { row: null, ambiguous: false };
  }

  if (error && String(error.message || "").toLowerCase().indexOf("unknown table") >= 0) {
    return { row: null, ambiguous: false };
  }

  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  if (list.length === 1) return { row: list[0], ambiguous: false };
  if (list.length > 1) return { row: null, ambiguous: true };

  const ulNorm = ul.toLowerCase();
  try {
    const r2 = await sb
      .from("units")
      .select("id, unit_label, property_code")
      .eq("property_code", prop);
    const rows2 = r2.data;
    const err2 = r2.error;
    if (err2 || !Array.isArray(rows2)) return { row: null, ambiguous: false };
    const hits = rows2.filter(
      (x) => String((x && x.unit_label) || "").trim().toLowerCase() === ulNorm
    );
    if (hits.length === 1) return { row: hits[0], ambiguous: false };
    if (hits.length > 1) return { row: null, ambiguous: true };
  } catch (_) {
    /* ignore */
  }

  return { row: null, ambiguous: false };
}

/**
 * @param {object} opts
 * @param {object | null} opts.sb
 * @param {'structured_portal'|'draft_hints'} opts.source
 * @param {string} opts.propertyCode
 * @param {object} [opts.portalPayload]
 * @param {{ locationType?: string, unitLabel?: string, issueText?: string, draft_issue?: string, reportSourceUnit?: string } | null} [opts.fastDraft]
 * @param {string} [opts.effectiveBody]
 * @param {string} [opts.issueText]
 * @returns {Promise<{ ok: boolean, target: object | null, error_code: string | null }>}
 */
async function resolveLocationTarget(opts) {
  const sb = opts.sb || null;
  const propertyCode = String(opts.propertyCode || "").trim();
  const propUpper = propertyCode.toUpperCase();

  if (!propertyCode) {
    return { ok: false, target: null, error_code: "unknown_property" };
  }

  if (opts.source === "structured_portal" && opts.portalPayload) {
    const j = opts.portalPayload;
    const kind = normalizeTargetKindFromPortal(
      j.location_kind != null ? j.location_kind : j.locationKind
    );
    if (kind !== "unit" && kind !== "common_area" && kind !== "property") {
      return { ok: false, target: null, error_code: "invalid_target_kind" };
    }

    const locIdRaw =
      j.location_id != null
        ? String(j.location_id).trim()
        : j.locationId != null
          ? String(j.locationId).trim()
          : "";
    if (locIdRaw && !isUuid(locIdRaw)) {
      return { ok: false, target: null, error_code: "unknown_target" };
    }

    const labelSnap = String(
      j.location_label_snapshot != null
        ? j.location_label_snapshot
        : j.locationLabelSnapshot != null
          ? j.locationLabelSnapshot
          : ""
    ).trim();

    const unitCatalogRaw = String(
      j.unit_catalog_id != null
        ? j.unit_catalog_id
        : j.unitCatalogId != null
          ? j.unitCatalogId
          : ""
    ).trim();
    if (unitCatalogRaw && !isUuid(unitCatalogRaw)) {
      return { ok: false, target: null, error_code: "unknown_target" };
    }

    const unitLabelFromPayload = String(j.unit != null ? j.unit : "").trim();

    if (kind === "unit") {
      let unitRow = null;
      if (unitCatalogRaw) {
        unitRow = await fetchUnitById(sb, propUpper, unitCatalogRaw);
        if (!unitRow) {
          return { ok: false, target: null, error_code: "unknown_target" };
        }
      } else if (unitLabelFromPayload) {
        const { row, ambiguous } = await fetchUnitByLabel(
          sb,
          propUpper,
          unitLabelFromPayload
        );
        if (ambiguous) {
          return { ok: false, target: null, error_code: "ambiguous_target" };
        }
        unitRow = row;
      }

      const unitLabelSnap = unitRow
        ? String(unitRow.unit_label || "").trim()
        : unitLabelFromPayload;
      if (!unitLabelSnap) {
        return { ok: false, target: null, error_code: "target_required" };
      }

      const unitCatalogId = unitRow ? String(unitRow.id) : null;

      return {
        ok: true,
        error_code: null,
        target: {
          kind: "unit",
          locationType: "UNIT",
          location_id: locIdRaw || null,
          location_label_snapshot: labelSnap || unitLabelSnap,
          unit_catalog_id: unitCatalogId,
          unit_label_snapshot: unitLabelSnap,
        },
      };
    }

    if (kind === "common_area") {
      let snap = labelSnap;
      let resolvedLocId = locIdRaw || null;
      if (locIdRaw) {
        const row = await getActivePropertyLocationById(sb, propUpper, locIdRaw);
        if (!row || String(row.kind || "") !== "common_area") {
          return { ok: false, target: null, error_code: "unknown_target" };
        }
        resolvedLocId = String(row.id);
        snap = labelSnap || String(row.label || "").trim() || "Common area";
      } else if (!snap) {
        snap = "Common area";
      }
      return {
        ok: true,
        error_code: null,
        target: {
          kind: "common_area",
          locationType: "COMMON_AREA",
          location_id: resolvedLocId,
          location_label_snapshot: snap,
          unit_catalog_id: null,
          unit_label_snapshot: "",
        },
      };
    }

    let snap = labelSnap || "Property-wide";
    let resolvedLocId = locIdRaw || null;
    if (locIdRaw) {
      const row = await getActivePropertyLocationById(sb, propUpper, locIdRaw);
      if (!row || String(row.kind || "") !== "property") {
        return { ok: false, target: null, error_code: "unknown_target" };
      }
      resolvedLocId = String(row.id);
      snap = labelSnap || String(row.label || "").trim() || "Property-wide";
    }
    return {
      ok: true,
      error_code: null,
      target: {
        kind: "property",
        locationType: "COMMON_AREA",
        location_id: resolvedLocId,
        location_label_snapshot: snap,
        unit_catalog_id: null,
        unit_label_snapshot: "",
      },
    };
  }

  const fastDraft =
    opts.fastDraft && typeof opts.fastDraft === "object" ? opts.fastDraft : null;
  const effectiveBody = String(opts.effectiveBody || "");
  const issueText = String(
    opts.issueText != null
      ? opts.issueText
      : fastDraft && fastDraft.issueText != null
        ? fastDraft.issueText
        : ""
  );
  const extra = [];
  if (fastDraft && fastDraft.draft_issue)
    extra.push(String(fastDraft.draft_issue));

  const lt = resolveMaintenanceDraftLocationType(
    fastDraft,
    effectiveBody,
    issueText,
    ...extra
  );
  const locationType = normalizeLocationType(lt);
  const common = isCommonAreaLocation(locationType);

  const unitLabelHint = String(
    (fastDraft && fastDraft.unitLabel) || ""
  ).trim();

  if (common) {
    const snap =
      issueText.slice(0, 300) ||
      effectiveBody.trim().slice(0, 300) ||
      "Common area";
    return {
      ok: true,
      error_code: null,
      target: {
        kind: "common_area",
        locationType: "COMMON_AREA",
        location_id: null,
        location_label_snapshot: snap,
        unit_catalog_id: null,
        unit_label_snapshot: "",
      },
    };
  }

  const { row: unitRow, ambiguous } = await fetchUnitByLabel(
    sb,
    propUpper,
    unitLabelHint
  );
  if (ambiguous) {
    return { ok: false, target: null, error_code: "ambiguous_target" };
  }

  const unitLabelSnap = unitRow
    ? String(unitRow.unit_label || "").trim()
    : unitLabelHint;

  if (!unitLabelSnap) {
    return { ok: false, target: null, error_code: "target_required" };
  }

  return {
    ok: true,
    error_code: null,
    target: {
      kind: "unit",
      locationType: "UNIT",
      location_id: null,
      location_label_snapshot: unitLabelSnap,
      unit_catalog_id: unitRow ? String(unitRow.id) : null,
      unit_label_snapshot: unitLabelSnap,
    },
  };
}

module.exports = {
  resolveLocationTarget,
  normalizeTargetKindFromPortal,
  isUuid,
};
