/**
 * Resolve management company org from request Host (subdomain or custom domain).
 * @see docs/TENANT_PORTAL_BUILD_PLAN.md §7
 */
const { getSupabase } = require("../db/supabase");
const { devOrgSubdomain } = require("../config/env");

function cleanHost(host) {
  return String(host || "")
    .trim()
    .split(":")[0]
    .toLowerCase();
}

function mapOrgRow(row) {
  if (!row) return null;
  return {
    id: String(row.id || "").trim(),
    brandName: String(row.brand_name || "").trim(),
    brandShortName: String(row.brand_short_name || "").trim(),
    showProperaAttribution: row.show_propera_attribution !== false,
    properaSubdomain: String(row.propera_subdomain || "").trim().toLowerCase(),
    customDomain: String(row.custom_domain || "").trim().toLowerCase(),
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} host
 * @returns {Promise<ReturnType<typeof mapOrgRow>>}
 */
async function resolveOrgFromHost(sb, host) {
  if (!sb) return null;
  const clean = cleanHost(host);
  if (!clean) return null;

  const useDevOrg =
    clean === "localhost" ||
    clean === "127.0.0.1" ||
    clean.endsWith(".vercel.app");

  if (useDevOrg) {
    const sub = devOrgSubdomain();
    const { data } = await sb
      .from("organizations")
      .select(
        "id, brand_name, brand_short_name, show_propera_attribution, propera_subdomain, custom_domain"
      )
      .eq("propera_subdomain", sub)
      .maybeSingle();
    return mapOrgRow(data);
  }

  const { data: byCustom } = await sb
    .from("organizations")
    .select(
      "id, brand_name, brand_short_name, show_propera_attribution, propera_subdomain, custom_domain"
    )
    .ilike("custom_domain", clean)
    .maybeSingle();
  if (byCustom) return mapOrgRow(byCustom);

  const subdomain = clean.split(".")[0];
  if (!subdomain) return null;

  const { data: bySub } = await sb
    .from("organizations")
    .select(
      "id, brand_name, brand_short_name, show_propera_attribution, propera_subdomain, custom_domain"
    )
    .eq("propera_subdomain", subdomain)
    .maybeSingle();

  return mapOrgRow(bySub);
}

module.exports = { resolveOrgFromHost, cleanHost };
