/**
 * Brand context for resident portal (org + property + contact).
 */
const { getSupabase } = require("../db/supabase");
const { commMainNumberDisplay } = require("../config/env");
const { tenantAmenitiesVisible } = require("./tenantAccessService");
const { tenantPaymentsVisible } = require("./tenantPaymentService");
const { normalizeTenantUiLocale } = require("./tenantI18nLocale");

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} orgId
 * @returns {Promise<object | null>}
 */
async function loadOrgBrandById(sb, orgId) {
  const id = String(orgId || "").trim();
  if (!id || !sb) return null;

  const { data: org } = await sb
    .from("organizations")
    .select(
      "id, brand_name, brand_short_name, show_propera_attribution, propera_subdomain, custom_domain"
    )
    .eq("id", id)
    .maybeSingle();
  if (!org) return null;

  const { data: prop } = await sb
    .from("properties")
    .select("code, display_name, display_name_short")
    .eq("org_id", id)
    .eq("active", true)
    .order("code", { ascending: true })
    .limit(1)
    .maybeSingle();

  return {
    orgId: id,
    orgBrandName: String(org.brand_name || "").trim(),
    orgBrandShort: String(org.brand_short_name || "").trim(),
    showProperaAttribution: org.show_propera_attribution !== false,
    propertyDisplayName: prop
      ? String(prop.display_name || prop.code || "").trim()
      : String(org.brand_short_name || "").trim(),
    propertyDisplayNameShort: prop
      ? String(prop.display_name_short || "").trim()
      : "",
    mainNumberE164: commMainNumberDisplay(),
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} rosterId
 * @param {string} orgId
 */
async function loadTenantSessionBrand(sb, rosterId, orgId) {
  const { data: row } = await sb
    .from("tenant_roster")
    .select(
      "id, resident_name, email, phone_e164, property_code, unit_label, active, portal_enabled, preferred_language"
    )
    .eq("id", rosterId)
    .maybeSingle();
  if (!row) return null;

  const propertyCode = String(row.property_code || "").trim().toUpperCase();
  const { data: prop } = await sb
    .from("properties")
    .select("code, display_name, display_name_short, org_id")
    .eq("code", propertyCode)
    .maybeSingle();

  if (!prop || String(prop.org_id || "").trim() !== String(orgId || "").trim()) {
    return null;
  }

  const { data: org } = await sb
    .from("organizations")
    .select("id, brand_name, brand_short_name, show_propera_attribution")
    .eq("id", orgId)
    .maybeSingle();

  const unitLabel = String(row.unit_label || "").trim();
  let unitId = "";
  let floor = "";
  const { data: unit } = await sb
    .from("units")
    .select("id, floor")
    .eq("property_code", propertyCode)
    .eq("unit_label", unitLabel)
    .maybeSingle();
  if (unit) {
    unitId = String(unit.id || "");
    floor = String(unit.floor || "").trim();
  }

  const amenitiesVisible = await tenantAmenitiesVisible({ propertyCode });
  const paymentsVisible = await tenantPaymentsVisible({ propertyCode });

  return {
    tenant: {
      id: String(row.id),
      name: String(row.resident_name || "").trim(),
      email: String(row.email || "").trim(),
      phone: String(row.phone_e164 || "").trim(),
      preferredLanguage: normalizeTenantUiLocale(row.preferred_language),
    },
    unit: { id: unitId, label: unitLabel, floor },
    property: {
      code: propertyCode,
      displayName: String(prop.display_name || propertyCode).trim(),
      displayNameShort: String(prop.display_name_short || "").trim(),
    },
    org: {
      brandName: String(org?.brand_name || "").trim(),
      brandShortName: String(org?.brand_short_name || "").trim(),
      showProperaAttribution: org?.show_propera_attribution !== false,
    },
    contact: { mainNumberE164: commMainNumberDisplay() },
    features: { amenitiesVisible, paymentsVisible },
  };
}

/**
 * @param {{ orgBrandShort: string, showProperaAttribution?: boolean }} brandCtx
 * @param {string} code
 */
function buildOtpMessage(code, brandCtx) {
  const base = `Your ${brandCtx.orgBrandShort} verification code is ${code}. Valid for 10 minutes.`;
  const attribution = brandCtx.showProperaAttribution ? " Powered by Propera." : "";
  return base + attribution;
}

module.exports = {
  loadOrgBrandById,
  loadTenantSessionBrand,
  buildOtpMessage,
};
