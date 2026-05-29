/**
 * Operational policy config — resolve namespaced keys from `property_policy`.
 * Portfolio scope uses property_code = GLOBAL; property overrides GLOBAL.
 *
 * @see docs/OPERATIONAL_POLICY_CONFIG.md
 */
const { getSupabase } = require("../../db/supabase");

/** Documented defaults when no row exists (logged as defaulted). */
const POLICY_DEFAULTS = {
  "conflict.monitoring_window_days": 14,
  "conflict.complainant_confidentiality": "always",
  "conflict.auto_escalate_after_violations": 2,
  "sched.earliest_hour": 9,
  "sched.latest_hour": 18,
};

const LEGACY_KEY_ALIASES = {
  "sched.earliest_hour": "SCHED_EARLIEST_HOUR",
  "sched.latest_hour": "SCHED_LATEST_HOUR",
  "sched.allow_weekends": "SCHED_ALLOW_WEEKENDS",
};

function parsePolicyValue(row) {
  if (!row) return undefined;
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
 * @param {string} policyKey — e.g. conflict.monitoring_window_days
 * @param {object} scope
 * @param {string} [scope.property] — property code
 * @param {string} [scope.org] — reserved (V1 unused)
 * @param {import('@supabase/supabase-js').SupabaseClient} [scope.sb]
 */
async function resolveOperationalPolicy(policyKey, scope = {}) {
  const key = String(policyKey || "").trim();
  if (!key) {
    return { ok: false, error: "missing_policy_key" };
  }

  const property = String(scope.property || scope.propertyCode || "").trim().toUpperCase();
  const codes = property && property !== "GLOBAL" ? [property, "GLOBAL"] : ["GLOBAL"];
  const lookupKeys = [key];
  const legacy = LEGACY_KEY_ALIASES[key];
  if (legacy) lookupKeys.push(legacy);

  const sb = scope.sb || getSupabase();
  if (!sb) {
    const fallback = POLICY_DEFAULTS[key];
    return {
      ok: true,
      value: fallback,
      policyKey: key,
      recordId: "",
      scopeUsed: "default",
      propertyCode: property || "GLOBAL",
      defaulted: true,
      noDb: true,
    };
  }

  const { data, error } = await sb
    .from("property_policy")
    .select("id, property_code, policy_key, value, value_type")
    .in("property_code", codes)
    .in("policy_key", lookupKeys);

  if (error) {
    return { ok: false, error: error.message || "policy_query_failed" };
  }

  let chosen = null;
  let scopeUsed = "GLOBAL";
  for (const row of data || []) {
    if (row.policy_key !== key && row.policy_key !== legacy) continue;
    const pc = String(row.property_code || "").toUpperCase();
    if (property && pc === property) {
      chosen = row;
      scopeUsed = property;
      break;
    }
    if (!chosen && pc === "GLOBAL") {
      chosen = row;
      scopeUsed = "GLOBAL";
    }
  }

  if (chosen) {
    const value = parsePolicyValue(chosen);
    return {
      ok: true,
      value,
      policyKey: key,
      recordId: String(chosen.id || ""),
      scopeUsed,
      propertyCode: chosen.property_code,
      defaulted: false,
    };
  }

  const fallback = POLICY_DEFAULTS[key];
  if (fallback === undefined) {
    return { ok: false, error: "policy_key_unknown", policyKey: key };
  }

  return {
    ok: true,
    value: fallback,
    policyKey: key,
    recordId: "",
    scopeUsed: "default",
    propertyCode: property || "GLOBAL",
    defaulted: true,
  };
}

/** @param {string} policyKey */
async function resolveOperationalPolicyNumber(policyKey, scope) {
  const out = await resolveOperationalPolicy(policyKey, scope);
  if (!out.ok) return out;
  const n = Number(out.value);
  if (!isFinite(n)) {
    return { ok: false, error: "policy_value_not_number", policyKey };
  }
  return { ...out, value: n };
}

module.exports = {
  resolveOperationalPolicy,
  resolveOperationalPolicyNumber,
  POLICY_DEFAULTS,
  LEGACY_KEY_ALIASES,
};
