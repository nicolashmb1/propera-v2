/**
 * PropertyPolicy (`property_policy` table) — GAS `ppGet_` parity for scheduling keys.
 * Merge: property-specific row overrides `GLOBAL`, then GAS function defaults from `validateSchedPolicy_`.
 */
const SCHED_POLICY_KEYS = [
  "SCHED_EARLIEST_HOUR",
  "SCHED_LATEST_HOUR",
  "SCHED_ALLOW_WEEKENDS",
  "SCHED_SAT_ALLOWED",
  "SCHED_SUN_ALLOWED",
  "SCHED_MIN_LEAD_HOURS",
  "SCHED_MAX_DAYS_OUT",
  "SCHED_SAT_LATEST_HOUR",
];

/** @type {Record<string, number|boolean>} — GAS `ppGet_(…, default)` when no row */
const PP_DEFAULTS = {
  SCHED_EARLIEST_HOUR: 9,
  SCHED_LATEST_HOUR: 18,
  SCHED_ALLOW_WEEKENDS: false,
  SCHED_SAT_ALLOWED: false,
  SCHED_SUN_ALLOWED: false,
  SCHED_MIN_LEAD_HOURS: 12,
  SCHED_MAX_DAYS_OUT: 14,
  SCHED_SAT_LATEST_HOUR: NaN,
};

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
 * Build merged snapshot for `validateSchedPolicy_` / `validateSchedWeekendAllowed_`.
 *
 * @param {object} sb — Supabase client
 * @param {string} propertyCode
 */
async function getSchedPolicySnapshot(sb, propertyCode) {
  const p = String(propertyCode || "").trim().toUpperCase() || "GLOBAL";
  const codes = p === "GLOBAL" ? ["GLOBAL"] : [p, "GLOBAL"];

  const { data, error } = await sb
    .from("property_policy")
    .select("property_code, policy_key, value, value_type")
    .in("property_code", codes)
    .in("policy_key", SCHED_POLICY_KEYS);

  const merged = {};
  if (!error && data && data.length) {
    const byKey = {};
    for (const row of data) {
      const k = row.policy_key;
      if (!byKey[k]) byKey[k] = {};
      byKey[k][row.property_code] = row;
    }
    for (const key of SCHED_POLICY_KEYS) {
      const bucket = byKey[key];
      const row =
        bucket && (bucket[p] || bucket["GLOBAL"]) ? bucket[p] || bucket["GLOBAL"] : null;
      if (row) merged[key] = parseCell(row);
    }
  }

  function num(key, fallback) {
    const v = merged[key];
    if (typeof v === "number" && isFinite(v)) return v;
    return fallback;
  }
  function bool(key, fallback) {
    const v = merged[key];
    if (typeof v === "boolean") return v;
    return fallback;
  }

  const earliest = num("SCHED_EARLIEST_HOUR", /** @type {number} */ (PP_DEFAULTS.SCHED_EARLIEST_HOUR));
  const latest = num("SCHED_LATEST_HOUR", /** @type {number} */ (PP_DEFAULTS.SCHED_LATEST_HOUR));
  const satLatestRaw = merged["SCHED_SAT_LATEST_HOUR"];
  const satLatest =
    typeof satLatestRaw === "number" && isFinite(satLatestRaw)
      ? satLatestRaw
      : NaN;

  return {
    earliestHour: earliest,
    latestHour: latest,
    allowWeekends: bool("SCHED_ALLOW_WEEKENDS", /** @type {boolean} */ (PP_DEFAULTS.SCHED_ALLOW_WEEKENDS)),
    schedSatAllowed: bool("SCHED_SAT_ALLOWED", /** @type {boolean} */ (PP_DEFAULTS.SCHED_SAT_ALLOWED)),
    schedSunAllowed: bool("SCHED_SUN_ALLOWED", /** @type {boolean} */ (PP_DEFAULTS.SCHED_SUN_ALLOWED)),
    minLeadHours: num("SCHED_MIN_LEAD_HOURS", /** @type {number} */ (PP_DEFAULTS.SCHED_MIN_LEAD_HOURS)),
    maxDaysOut: num("SCHED_MAX_DAYS_OUT", /** @type {number} */ (PP_DEFAULTS.SCHED_MAX_DAYS_OUT)),
    schedSatLatestHour: satLatest,
  };
}

module.exports = {
  getSchedPolicySnapshot,
  SCHED_POLICY_KEYS,
};
