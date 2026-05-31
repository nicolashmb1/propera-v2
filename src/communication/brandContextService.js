const { getSupabase } = require("../db/supabase");
const { communicationOrgId } = require("../config/env");

function normalizePropertyCodes(propertyCodes) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(propertyCodes) ? propertyCodes : [];
  for (const raw of list) {
    const code = String(raw || "").trim().toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

function buildPropertyContext(row) {
  const code = String((row && row.code) || "").trim().toUpperCase();
  const displayName =
    String((row && row.display_name) || "").trim() ||
    String((row && row.short_name) || "").trim() ||
    code;
  const displayNameShort =
    String((row && row.display_name_short) || "").trim() ||
    String((row && row.short_name) || "").trim() ||
    displayName ||
    code;
  const senderLabel =
    String((row && row.comm_sender_label) || "").trim() ||
    "Management at " + displayName;
  return {
    code,
    displayName,
    displayNameShort,
    senderLabel,
  };
}

async function getBrandContext(input) {
  const sb = getSupabase();
  const opts = input && typeof input === "object" ? input : {};
  const orgId = String(opts.orgId || communicationOrgId()).trim();
  const propertyCodes = normalizePropertyCodes(opts.propertyCodes);

  const out = {
    orgId,
    orgBrandName: "",
    orgBrandShort: "",
    properties: {},
  };

  if (!sb) return out;

  try {
    const { data: orgRow } = await sb
      .from("organizations")
      .select("id, brand_name, brand_short_name")
      .eq("id", orgId)
      .maybeSingle();
    if (orgRow) {
      out.orgBrandName = String(orgRow.brand_name || "").trim();
      out.orgBrandShort = String(orgRow.brand_short_name || "").trim();
    }
  } catch (_) {
    // Fresh dev DBs may not have the communication migration yet.
  }

  let query = sb
    .from("properties")
    .select("code, display_name, display_name_short, short_name, comm_sender_label")
    .eq("active", true);
  if (propertyCodes.length) {
    query = query.in("code", propertyCodes);
  }

  const { data: rows } = await query.order("code", { ascending: true });
  for (const row of rows || []) {
    const ctx = buildPropertyContext(row);
    if (!ctx.code) continue;
    out.properties[ctx.code] = ctx;
  }

  return out;
}

function getAudienceLabel(brandContext, audienceKind, audienceFilter) {
  const ctx = brandContext && typeof brandContext === "object" ? brandContext : { properties: {} };
  const filter = audienceFilter && typeof audienceFilter === "object" ? audienceFilter : {};
  const propertyCodes = normalizePropertyCodes(filter.property_codes);
  const floors = Array.isArray(filter.floors)
    ? filter.floors.map((v) => String(v || "").trim()).filter(Boolean)
    : [];
  const unitIds = Array.isArray(filter.unit_ids) ? filter.unit_ids.filter(Boolean) : [];
  const tenantIds = Array.isArray(filter.tenant_ids) ? filter.tenant_ids.filter(Boolean) : [];
  const kind = String(audienceKind || "").trim().toUpperCase();

  const singlePropertyCode = propertyCodes.length === 1 ? propertyCodes[0] : "";
  const singleProperty =
    (singlePropertyCode && ctx.properties && ctx.properties[singlePropertyCode]) || null;
  const singlePropertyName = singleProperty
    ? singleProperty.displayName
    : singlePropertyCode;

  if (kind === "PORTFOLIO") return "all portfolio residents";
  if (kind === "PROPERTY") {
    if (singlePropertyName) return "all residents at " + singlePropertyName;
    return propertyCodes.length > 1 ? "residents at selected properties" : "selected residents";
  }
  if (kind === "FLOOR") {
    if (singlePropertyName && floors.length === 1) {
      return "floor " + floors[0] + " residents at " + singlePropertyName;
    }
    if (floors.length) return "selected floor residents";
    return "selected residents";
  }
  if (kind === "UNIT") {
    if (singlePropertyName && unitIds.length === 1) {
      return "selected unit resident at " + singlePropertyName;
    }
    return unitIds.length > 1 ? "selected unit residents" : "selected resident";
  }
  if (kind === "TENANT") {
    return tenantIds.length === 1 ? "selected resident" : "selected residents";
  }
  return "selected residents";
}

module.exports = {
  getBrandContext,
  getAudienceLabel,
  normalizePropertyCodes,
};
