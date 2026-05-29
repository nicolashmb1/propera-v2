/**
 * Resolve subject tenant roster row for a conflict case (property + unit).
 */
const { normalizeUnit_ } = require("../brain/shared/extractUnitGas");
const { normalizePhoneE164 } = require("../utils/phone");
const {
  findTenantCandidates,
  pickResolvedTenantPhone,
} = require("../dal/tenantRoster");

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} propertyCode
 * @param {string} unitLabel
 * @param {string | null} [explicitRosterId]
 */
async function resolveSubjectTenantForConflict(sb, propertyCode, unitLabel, explicitRosterId) {
  const code = String(propertyCode || "").trim().toUpperCase();
  const unit = String(unitLabel || "").trim();
  if (!sb || !code || !unit) {
    return { ok: false, error: "missing_subject_context" };
  }

  if (explicitRosterId) {
    const id = String(explicitRosterId).trim();
    const { data, error } = await sb
      .from("tenant_roster")
      .select("id, property_code, unit_label, phone_e164, resident_name, active")
      .eq("id", id)
      .maybeSingle();
    if (error) return { ok: false, error: error.message || "roster_lookup_failed" };
    if (!data || !data.active) return { ok: false, error: "subject_tenant_not_found" };
    if (String(data.property_code || "").trim().toUpperCase() !== code) {
      return { ok: false, error: "subject_tenant_property_mismatch" };
    }
    const phone = normalizePhoneE164(String(data.phone_e164 || ""));
    if (!phone) return { ok: false, error: "subject_tenant_no_phone" };
    return {
      ok: true,
      tenant: {
        id: data.id,
        phoneE164: phone,
        residentName: String(data.resident_name || "").trim(),
        unitLabel: String(data.unit_label || "").trim(),
      },
    };
  }

  const candidates = await findTenantCandidates(sb, code, unit, "");
  const picked = pickResolvedTenantPhone(candidates, "");
  if (!picked.phoneE164) {
    return { ok: false, error: picked.status === "AMBIGUOUS" ? "subject_tenant_ambiguous" : "subject_tenant_no_phone" };
  }

  const wantUnit = normalizeUnit_(unit);
  const { data: rows, error } = await sb
    .from("tenant_roster")
    .select("id, phone_e164, resident_name, unit_label, active")
    .eq("property_code", code)
    .eq("active", true);

  if (error) return { ok: false, error: error.message || "roster_lookup_failed" };

  const match = (rows || []).find((row) => {
    if (normalizeUnit_(String(row.unit_label || "")) !== wantUnit) return false;
    return normalizePhoneE164(String(row.phone_e164 || "")) === picked.phoneE164;
  });

  if (!match) return { ok: false, error: "subject_tenant_not_found" };

  return {
    ok: true,
    tenant: {
      id: match.id,
      phoneE164: picked.phoneE164,
      residentName: String(match.resident_name || picked.matchedName || "").trim(),
      unitLabel: String(match.unit_label || unit).trim(),
      lookupStatus: picked.status,
    },
  };
}

module.exports = {
  resolveSubjectTenantForConflict,
};
