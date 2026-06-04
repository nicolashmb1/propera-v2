/**
 * Resolve tenant_roster id for amenity staff bookings.
 */
const { getSupabase } = require("../../db/supabase");
const { normalizeUnit_ } = require("../../brain/shared/extractUnitGas");
const { scoreNameMatch_ } = require("../../brain/gas/extractStaffTenantNameHintFromText");

/**
 * @param {object} opts
 * @param {string} opts.propertyCode
 * @param {string} opts.unitLabel
 * @param {string} [opts.tenantNameHint]
 */
async function resolveAmenityTenant(opts) {
  const propertyCode = String(opts?.propertyCode || "")
    .trim()
    .toUpperCase();
  const unitLabel = String(opts?.unitLabel || opts?.unit_label || "").trim();
  const tenantNameHint = String(opts?.tenantNameHint || opts?.tenant_name || "").trim();

  if (!propertyCode || !unitLabel) {
    return { ok: false, error: "missing_input", message: "Need property and unit for the tenant." };
  }

  const sb = getSupabase();
  if (!sb) {
    return { ok: false, error: "no_db", message: "Database is not configured." };
  }

  const wantUnit = normalizeUnit_(unitLabel);
  const { data, error } = await sb
    .from("tenant_roster")
    .select("id, resident_name, unit_label, active")
    .eq("property_code", propertyCode)
    .eq("active", true);

  if (error || !data?.length) {
    return {
      ok: false,
      error: "no_tenant",
      message: `No active tenant roster for ${propertyCode} unit ${unitLabel}.`,
    };
  }

  const rows = data.filter((r) => normalizeUnit_(String(r.unit_label || "")) === wantUnit);
  if (!rows.length) {
    return {
      ok: false,
      error: "no_tenant",
      message: `No active tenant on roster for ${propertyCode} unit ${unitLabel}.`,
    };
  }

  if (tenantNameHint) {
    const qn = tenantNameHint.toLowerCase();
    const matched = rows
      .map((r) => ({
        ...r,
        score: scoreNameMatch_(qn, String(r.resident_name || "")),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);

    if (matched.length === 1) {
      return {
        ok: true,
        tenantId: String(matched[0].id),
        tenantName: String(matched[0].resident_name || "").trim(),
      };
    }
    if (matched.length > 1) {
      const names = matched
        .slice(0, 3)
        .map((r) => r.resident_name)
        .join(", ");
      return {
        ok: false,
        error: "ambiguous_tenant",
        message: `Multiple tenants in unit ${unitLabel} — ${names}?`,
        candidates: matched,
      };
    }
  }

  if (rows.length === 1) {
    return {
      ok: true,
      tenantId: String(rows[0].id),
      tenantName: String(rows[0].resident_name || "").trim(),
    };
  }

  const names = rows
    .slice(0, 3)
    .map((r) => r.resident_name)
    .join(", ");
  return {
    ok: false,
    error: "ambiguous_tenant",
    message: `Multiple tenants in unit ${unitLabel} — which one: ${names}?`,
    candidates: rows,
  };
}

module.exports = { resolveAmenityTenant };
