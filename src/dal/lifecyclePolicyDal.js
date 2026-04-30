/**
 * GAS `ppGet_` / `lifecyclePolicyGet_` — arbitrary keys from `property_policy` (property overrides GLOBAL).
 */
function parseCell(row) {
  const t = String(row.value_type || "").toUpperCase();
  const raw = String(row.value != null ? row.value : "").trim();
  if (t === "BOOL") return /^true$/i.test(raw);
  if (t === "NUMBER") {
    const n = Number(raw);
    return raw === "" || !isFinite(n) ? NaN : n;
  }
  const n = Number(raw);
  if (raw !== "" && isFinite(n)) return n;
  return raw;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} propertyCode
 * @param {string} policyKey
 * @param {boolean|number|string|null|undefined} fallback
 */
async function lifecyclePolicyGet(sb, propertyCode, policyKey, fallback) {
  const key = String(policyKey || "").trim();
  if (!sb || !key) return fallback;

  const p = String(propertyCode || "").trim().toUpperCase() || "GLOBAL";
  const codes = p === "GLOBAL" ? ["GLOBAL"] : [p, "GLOBAL"];

  const { data, error } = await sb
    .from("property_policy")
    .select("property_code, policy_key, value, value_type")
    .eq("policy_key", key)
    .in("property_code", codes);

  if (error || !data || !data.length) return fallback;

  const propRow = data.find((r) => r.property_code === p);
  const globalRow = data.find((r) => r.property_code === "GLOBAL");
  const row = propRow || globalRow;
  if (!row) return fallback;

  const v = parseCell(row);
  if (typeof v === "number" && !isFinite(v) && key.indexOf("HOUR") < 0) return fallback;
  return v;
}

/**
 * GAS `lifecycleEnabled_` — `LIFECYCLE_ENABLED` property then GLOBAL; default false.
 */
async function lifecycleEnabledForProperty(sb, propertyCode) {
  const p = String(propertyCode || "").trim().toUpperCase() || "GLOBAL";
  let v = await lifecyclePolicyGet(sb, p, "LIFECYCLE_ENABLED", null);
  if (v == null || (typeof v === "string" && String(v).trim() === "")) {
    v = await lifecyclePolicyGet(sb, "GLOBAL", "LIFECYCLE_ENABLED", false);
  }
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

module.exports = {
  lifecyclePolicyGet,
  lifecycleEnabledForProperty,
  parseCell,
};
