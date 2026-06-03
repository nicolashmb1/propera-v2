/**
 * Brand context for Max voice — resolved from caller roster property, not global default org.
 */
const { getSupabase } = require("../db/supabase");
const { loadOrgBrandById } = require("../tenant/tenantBrandResolve");
const { defaultOrgId } = require("../config/env");

function fallbackBrand() {
  return {
    orgBrandName: "your property management team",
    orgBrandShort: "the team",
    propertyDisplayName: "your property",
    showProperaAttribution: false,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient | null | undefined} sb
 * @param {{ property_code?: string } | null | undefined} rosterRow
 */
async function loadVoiceBrandForRoster(sb, rosterRow) {
  const client = sb || getSupabase();
  const propertyCode = String(rosterRow?.property_code || "").trim().toUpperCase();

  if (client && propertyCode) {
    const { data: prop } = await client
      .from("properties")
      .select("code, display_name, display_name_short, org_id")
      .eq("code", propertyCode)
      .maybeSingle();

    const orgId = String(prop?.org_id || "").trim();
    if (prop && orgId) {
      const orgBrand = await loadOrgBrandById(client, orgId);
      if (orgBrand) {
        return {
          orgBrandName: orgBrand.orgBrandName,
          orgBrandShort: orgBrand.orgBrandShort,
          propertyDisplayName: String(prop.display_name || prop.code || propertyCode).trim(),
          showProperaAttribution: orgBrand.showProperaAttribution,
        };
      }
    }
  }

  if (client) {
    const orgId = defaultOrgId();
    if (orgId) {
      const orgBrand = await loadOrgBrandById(client, orgId);
      if (orgBrand) {
        return {
          orgBrandName: orgBrand.orgBrandName,
          orgBrandShort: orgBrand.orgBrandShort,
          propertyDisplayName: orgBrand.propertyDisplayName,
          showProperaAttribution: orgBrand.showProperaAttribution,
        };
      }
    }
  }

  return fallbackBrand();
}

module.exports = { loadVoiceBrandForRoster, fallbackBrand };
