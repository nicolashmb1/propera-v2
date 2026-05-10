/**
 * PM portal `create_ticket` — structured signal only (no free-text intake / compileTurn).
 * Validates property against DB menu; uses JSON fields for issue/unit; preferredWindow is schedule raw only.
 *
 * `location_kind`: `unit` (default) | `common_area` | `property` — common-area/property tickets omit unit.
 * Optional: `unit_catalog_id`, `location_id`, `location_label_snapshot`, `report_source_unit`.
 *
 * PARITY GAP: deliberate product divergence vs SMS tenant intake — see docs/PARITY_LEDGER.md (portal row).
 */

const { normalizeTargetKindFromPortal, isUuid } = require("../location/resolveLocationTarget");

function normalizePropToken(s) {
  return String(s || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

/**
 * Resolve portal `property` string to canonical `properties.code` (uppercase).
 * @param {string} inputRaw
 * @param {Set<string>} knownPropertyCodesUpper
 * @param {Array<{ code: string, display_name?: string, ticket_prefix?: string, short_name?: string, aliases?: string[] }>} propertiesList
 * @returns {string}
 */
function resolvePortalPropertyCode(inputRaw, knownPropertyCodesUpper, propertiesList) {
  const token = normalizePropToken(inputRaw);
  if (!token) return "";
  if (knownPropertyCodesUpper && knownPropertyCodesUpper.has(token)) return token;

  const pl = propertiesList || [];
  for (const row of pl) {
    const code = String(row.code || "").trim().toUpperCase();
    if (!code) continue;
    if (token === normalizePropToken(code)) return code;

    const tp = normalizePropToken(row.ticket_prefix);
    const sn = normalizePropToken(row.short_name);
    const dn = normalizePropToken(row.display_name);
    if (tp && token === tp) return code;
    if (sn && token === sn) return code;
    if (dn && token === dn) return code;

    const aliases = Array.isArray(row.aliases) ? row.aliases : [];
    for (const a of aliases) {
      if (token === normalizePropToken(a)) return code;
    }
  }
  return "";
}

/**
 * @param {Record<string, unknown>} routerParameter
 * @param {Set<string>} knownPropertyCodesUpper
 * @param {Array<{ code: string, display_name?: string, ticket_prefix?: string, short_name?: string, aliases?: string[] }>} propertiesList
 * @returns {{ propertyCode: string, unitLabel: string, issueText: string, structuredIssues: null, scheduleRaw: string, openerNext: string, locationType: string, portalLocationKind: string, reportSourceUnit: string } | null}
 */
function buildStructuredPortalCreateDraft(
  routerParameter,
  knownPropertyCodesUpper,
  propertiesList
) {
  const p = routerParameter || {};
  let j = {};
  try {
    j = JSON.parse(String(p._portalPayloadJson || "{}"));
  } catch (_) {
    return null;
  }

  const propertyCode = resolvePortalPropertyCode(
    j.property,
    knownPropertyCodesUpper,
    propertiesList
  );
  const locationKind = normalizeTargetKindFromPortal(
    j.location_kind != null ? j.location_kind : j.locationKind
  );
  const unitLabel = String(j.unit != null ? j.unit : "").trim();
  const unitCatalogRaw = String(
    j.unit_catalog_id != null
      ? j.unit_catalog_id
      : j.unitCatalogId != null
        ? j.unitCatalogId
        : ""
  ).trim();
  const issueText = String(j.message != null ? j.message : "").trim();
  const scheduleRaw = String(
    j.preferredWindow != null ? j.preferredWindow : ""
  ).trim();
  const reportSourceUnit = String(
    j.report_source_unit != null
      ? j.report_source_unit
      : j.reportSourceUnit != null
        ? j.reportSourceUnit
        : ""
  ).trim();

  if (!propertyCode || issueText.length < 2) return null;

  if (locationKind === "unit") {
    if (!unitLabel && !(unitCatalogRaw && isUuid(unitCatalogRaw))) return null;
  }

  const locationType = locationKind === "unit" ? "UNIT" : "COMMON_AREA";

  return {
    propertyCode,
    unitLabel: locationKind === "unit" ? unitLabel : "",
    issueText,
    structuredIssues: null,
    scheduleRaw,
    openerNext: "",
    locationType,
    portalLocationKind: locationKind,
    reportSourceUnit,
  };
}

module.exports = {
  buildStructuredPortalCreateDraft,
  resolvePortalPropertyCode,
  normalizePropToken,
};
