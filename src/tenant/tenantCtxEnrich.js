/**
 * Hydrate tenant session context from roster when JWT is missing fields
 * (e.g. tokens issued before unitLabel was embedded).
 */
const { normalizePhoneE164 } = require("../utils/phone");

/**
 * @param {import("@supabase/supabase-js").SupabaseClient | null} sb
 * @param {{ tenantId: string, phone: string, propertyCode: string, unitLabel?: string, unitId?: string, orgId?: string }} ctx
 */
async function enrichTenantCtx(sb, ctx) {
  const phone = normalizePhoneE164(ctx.phone);
  let unitLabel = String(ctx.unitLabel || "").trim();
  let propertyCode = String(ctx.propertyCode || "").trim().toUpperCase();

  if (sb && ctx.tenantId && (!unitLabel || !phone || !propertyCode)) {
    const { data } = await sb
      .from("tenant_roster")
      .select("unit_label, phone_e164, property_code")
      .eq("id", ctx.tenantId)
      .maybeSingle();
    if (data) {
      if (!unitLabel) unitLabel = String(data.unit_label || "").trim();
      if (!propertyCode) {
        propertyCode = String(data.property_code || "").trim().toUpperCase();
      }
    }
  }

  return {
    ...ctx,
    phone: phone || normalizePhoneE164(ctx.phone),
    unitLabel,
    propertyCode: propertyCode || String(ctx.propertyCode || "").trim().toUpperCase(),
  };
}

module.exports = { enrichTenantCtx };
