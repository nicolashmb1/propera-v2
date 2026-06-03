/**
 * Hydrate tenant session context from roster when JWT is missing fields
 * (e.g. tokens issued before unitLabel was embedded).
 */
const { normalizePhoneE164 } = require("../utils/phone");
const { normalizeTenantUiLocale } = require("./tenantI18nLocale");

/**
 * @param {import("@supabase/supabase-js").SupabaseClient | null} sb
 * @param {{ tenantId: string, phone: string, propertyCode: string, unitLabel?: string, unitId?: string, orgId?: string }} ctx
 */
async function enrichTenantCtx(sb, ctx) {
  const phone = normalizePhoneE164(ctx.phone);
  let unitLabel = String(ctx.unitLabel || "").trim();
  let propertyCode = String(ctx.propertyCode || "").trim().toUpperCase();

  let unitId = String(ctx.unitId || "").trim();
  let preferredLanguage = normalizeTenantUiLocale(ctx.preferredLanguage);

  if (sb && ctx.tenantId) {
    const needsRoster =
      !unitLabel || !phone || !propertyCode || !unitId || !ctx.preferredLanguage;
    if (needsRoster) {
      const { data } = await sb
        .from("tenant_roster")
        .select("unit_label, phone_e164, property_code, preferred_language")
        .eq("id", ctx.tenantId)
        .maybeSingle();
      if (data) {
        if (!unitLabel) unitLabel = String(data.unit_label || "").trim();
        if (!propertyCode) {
          propertyCode = String(data.property_code || "").trim().toUpperCase();
        }
        if (!unitId && propertyCode && unitLabel) {
          const { data: unit } = await sb
            .from("units")
            .select("id")
            .eq("property_code", propertyCode)
            .eq("unit_label", unitLabel)
            .maybeSingle();
          if (unit) unitId = String(unit.id || "").trim();
        }
        if (data.preferred_language) {
          preferredLanguage = normalizeTenantUiLocale(data.preferred_language);
        }
      }
    }
  }

  return {
    ...ctx,
    phone: phone || normalizePhoneE164(ctx.phone),
    unitLabel,
    propertyCode: propertyCode || String(ctx.propertyCode || "").trim().toUpperCase(),
    unitId,
    preferredLanguage,
  };
}

module.exports = { enrichTenantCtx };
