/**
 * Resident profile updates — tenant_roster scoped by JWT tenantId.
 * Phone/name read-only. Email + preferred_language (en | es).
 * @see docs/TENANT_PORTAL_I18N.md
 */

const { loadTenantSessionBrand } = require("./tenantBrandResolve");
const { isSupportedTenantUiLocale, normalizeTenantUiLocale } = require("./tenantI18nLocale");

/**
 * @param {string} raw
 * @returns {string | null} normalized email, or null if invalid
 */
function normalizeTenantEmail(raw) {
  const e = String(raw || "").trim().toLowerCase();
  if (!e) return "";
  if (e.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ tenantId: string, orgId: string }} ctx
 * @param {{ email?: string }} body
 */
async function updateTenantProfile(sb, ctx, body) {
  const tenantId = String(ctx.tenantId || "").trim();
  const orgId = String(ctx.orgId || "").trim();
  if (!tenantId || !orgId) {
    return { ok: false, error: "missing_tenant_context" };
  }

  if (!body || typeof body !== "object") {
    return { ok: false, error: "invalid_body" };
  }

  const hasEmail = Object.prototype.hasOwnProperty.call(body, "email");
  const hasLanguage = Object.prototype.hasOwnProperty.call(body, "preferredLanguage");
  if (!hasEmail && !hasLanguage) {
    return { ok: false, error: "nothing_to_update" };
  }

  let email;
  if (hasEmail) {
    email = normalizeTenantEmail(body.email);
    if (email === null) {
      return { ok: false, error: "invalid_email" };
    }
  }

  let preferredLanguage;
  if (hasLanguage) {
    const raw = String(body.preferredLanguage || "").trim().toLowerCase();
    if (!isSupportedTenantUiLocale(raw)) {
      return { ok: false, error: "invalid_preferred_language" };
    }
    preferredLanguage = normalizeTenantUiLocale(raw);
  }

  const { data: row, error: fetchErr } = await sb
    .from("tenant_roster")
    .select("id, property_code, active, portal_enabled")
    .eq("id", tenantId)
    .maybeSingle();

  if (fetchErr) return { ok: false, error: fetchErr.message };
  if (!row || row.portal_enabled === false || row.active === false) {
    return { ok: false, error: "tenant_not_found" };
  }

  const propertyCode = String(row.property_code || "").trim().toUpperCase();
  const { data: prop } = await sb
    .from("properties")
    .select("org_id")
    .eq("code", propertyCode)
    .maybeSingle();

  if (!prop || String(prop.org_id || "").trim() !== orgId) {
    return { ok: false, error: "org_mismatch" };
  }

  const patch = {};
  if (hasEmail) patch.email = email;
  if (hasLanguage) patch.preferred_language = preferredLanguage;

  const { error: updErr } = await sb
    .from("tenant_roster")
    .update(patch)
    .eq("id", tenantId);

  if (updErr) return { ok: false, error: updErr.message };

  const session = await loadTenantSessionBrand(sb, tenantId, orgId);
  if (!session) return { ok: false, error: "session_invalid" };

  return { ok: true, ...session };
}

module.exports = { normalizeTenantEmail, updateTenantProfile };
