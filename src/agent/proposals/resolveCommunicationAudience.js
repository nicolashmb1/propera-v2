/**
 * Resolve Communication Engine audience_kind + audience_filter for Jarvis proposals.
 */
const { getSupabase } = require("../../db/supabase");
const { normalizeUnit_ } = require("../../brain/shared/extractUnitGas");
const { resolveJarvisPropertyForCreate } = require("./resolveJarvisProperty");
const { resolveAmenityTenant } = require("./resolveAmenityTenant");

const AUDIENCE_SCOPES = new Set(["portfolio", "property", "floor", "unit", "tenant"]);

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} propertyCode
 * @param {string} unitLabel
 */
async function lookupUnitId(sb, propertyCode, unitLabel) {
  const code = String(propertyCode || "")
    .trim()
    .toUpperCase();
  const want = normalizeUnit_(unitLabel);
  if (!code || !want) return { ok: false, error: "missing_unit_input" };

  const { data, error } = await sb
    .from("units")
    .select("id, unit_label")
    .eq("property_code", code);
  if (error) return { ok: false, error: error.message || "unit_lookup_failed" };

  const row = (data || []).find((r) => normalizeUnit_(String(r.unit_label || "")) === want);
  if (!row?.id) {
    return {
      ok: false,
      error: "unit_not_found",
      message: `No unit ${unitLabel} found at ${code}.`,
    };
  }
  return { ok: true, unitId: String(row.id).trim() };
}

/**
 * @param {object} opts
 * @param {string} [opts.audienceScope] — portfolio | property | floor | unit | tenant
 * @param {string} [opts.propertyHint]
 * @param {string} [opts.propertyCode]
 * @param {string} [opts.floor]
 * @param {string} [opts.unitLabel]
 * @param {string} [opts.tenantName]
 * @param {object} [opts.scope]
 * @param {object} [opts.pageContext]
 * @param {string} [opts.traceId]
 */
async function resolveCommunicationAudience(opts) {
  const o = opts || {};
  const scopeRaw = String(o.audienceScope || o.audience_scope || "property")
    .trim()
    .toLowerCase();
  const audienceScope = AUDIENCE_SCOPES.has(scopeRaw) ? scopeRaw : "property";

  if (audienceScope === "portfolio") {
    return {
      ok: true,
      audienceKind: "PORTFOLIO",
      audienceFilter: { property_codes: [], floors: [], unit_ids: [], tenant_ids: [] },
    };
  }

  const propertyHint =
    o.propertyCode ||
    o.property_code ||
    o.propertyHint ||
    o.property_hint ||
    o.scope?.anchor?.propertyCode ||
    o.pageContext?.propertyCode ||
    o.pageContext?.property_code ||
    "";

  const propResolved = await resolveJarvisPropertyForCreate({
    propertyHint,
    scope: o.scope,
    pageContext: o.pageContext,
    traceId: o.traceId,
  });
  if (!propResolved.ok) {
    return {
      ok: false,
      error: propResolved.error || "missing_property",
      message: propResolved.message || "Need a property for this audience.",
    };
  }
  const propertyCode = propResolved.propertyCode;

  if (audienceScope === "property") {
    return {
      ok: true,
      audienceKind: "PROPERTY",
      audienceFilter: {
        property_codes: [propertyCode],
        floors: [],
        unit_ids: [],
        tenant_ids: [],
      },
      propertyCode,
    };
  }

  const floor = String(o.floor || "").trim();
  if (audienceScope === "floor") {
    if (!floor) {
      return {
        ok: false,
        error: "missing_floor",
        message: "Need a floor number for a floor-wide message.",
      };
    }
    return {
      ok: true,
      audienceKind: "FLOOR",
      audienceFilter: {
        property_codes: [propertyCode],
        floors: [floor],
        unit_ids: [],
        tenant_ids: [],
      },
      propertyCode,
    };
  }

  const unitLabel = String(o.unitLabel || o.unit_label || o.scope?.anchor?.unit || o.pageContext?.unit || "").trim();
  if (!unitLabel) {
    return {
      ok: false,
      error: "missing_unit",
      message: "Need a unit number for a unit or tenant message.",
    };
  }

  if (audienceScope === "unit") {
    const sb = getSupabase();
    if (!sb) return { ok: false, error: "no_db", message: "Database is not configured." };
    const unitOut = await lookupUnitId(sb, propertyCode, unitLabel);
    if (!unitOut.ok) {
      return {
        ok: false,
        error: unitOut.error,
        message: unitOut.message || "Could not resolve that unit.",
      };
    }
    return {
      ok: true,
      audienceKind: "UNIT",
      audienceFilter: {
        property_codes: [propertyCode],
        floors: [],
        unit_ids: [unitOut.unitId],
        tenant_ids: [],
      },
      propertyCode,
      unitLabel,
    };
  }

  if (audienceScope === "tenant") {
    const tenantName = String(o.tenantName || o.tenant_name || "").trim();
    const tenantOut = await resolveAmenityTenant({
      propertyCode,
      unitLabel,
      tenantNameHint: tenantName,
    });
    if (!tenantOut.ok) {
      return {
        ok: false,
        error: tenantOut.error || "no_tenant",
        message: tenantOut.message || "Could not resolve that tenant.",
      };
    }
    return {
      ok: true,
      audienceKind: "TENANT",
      audienceFilter: {
        property_codes: [propertyCode],
        floors: [],
        unit_ids: [],
        tenant_ids: [tenantOut.tenantId],
      },
      propertyCode,
      unitLabel,
      tenantName: tenantOut.tenantName,
    };
  }

  return {
    ok: false,
    error: "invalid_audience_scope",
    message: "Could not resolve the message audience.",
  };
}

module.exports = {
  AUDIENCE_SCOPES,
  lookupUnitId,
  resolveCommunicationAudience,
};
