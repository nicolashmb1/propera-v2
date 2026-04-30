/**
 * Load CONTACT_* policy into a shape for `lifecycleContactWindowCore`.
 */
const { lifecyclePolicyGet } = require("../../dal/lifecyclePolicyDal");

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} propertyCode
 */
async function loadContactPolicy(sb, propertyCode) {
  const prop = String(propertyCode || "").trim().toUpperCase() || "GLOBAL";
  let earliest = await lifecyclePolicyGet(sb, prop, "CONTACT_EARLIEST_HOUR", 9);
  let latest = await lifecyclePolicyGet(sb, prop, "CONTACT_LATEST_HOUR", 18);
  const satAllowed = !!(
    await lifecyclePolicyGet(sb, prop, "CONTACT_SAT_ALLOWED", false)
  );
  let satLatest = await lifecyclePolicyGet(
    sb,
    prop,
    "CONTACT_SAT_LATEST_HOUR",
    13
  );
  const sunAllowed = !!(
    await lifecyclePolicyGet(sb, prop, "CONTACT_SUN_ALLOWED", false)
  );

  earliest = Number(earliest);
  latest = Number(latest);
  satLatest = Number(satLatest);
  if (!isFinite(earliest)) earliest = 9;
  if (!isFinite(latest)) latest = 18;
  if (!isFinite(satLatest)) satLatest = 13;

  return {
    earliest,
    latest,
    satAllowed,
    satLatest,
    sunAllowed,
  };
}

/**
 * GAS `lifecycleImmediateIntentRespectsContactHours_` for TENANT_VERIFY_RESOLUTION.
 */
async function tenantVerifyRespectsContactHours(sb, propertyCode) {
  const prop = String(propertyCode || "").trim().toUpperCase() || "GLOBAL";
  return !!(
    await lifecyclePolicyGet(sb, prop, "TENANT_VERIFY_RESPECT_CONTACT_HOURS", false)
  );
}

/**
 * GAS `lifecycleTimerRespectsContactHours_`
 */
async function timerTypeRespectsContactHours(sb, propertyCode, timerType) {
  const prop = String(propertyCode || "").trim().toUpperCase() || "GLOBAL";
  const t = String(timerType || "").trim().toUpperCase();
  if (t === "PING_STAFF_UPDATE") {
    return !!(
      await lifecyclePolicyGet(
        sb,
        prop,
        "PING_STAFF_UPDATE_RESPECT_CONTACT_HOURS",
        false
      )
    );
  }
  if (t === "PING_UNSCHEDULED") {
    return !!(
      await lifecyclePolicyGet(
        sb,
        prop,
        "PING_UNSCHEDULED_RESPECT_CONTACT_HOURS",
        false
      )
    );
  }
  if (t === "TIMER_ESCALATE") {
    return !!(
      await lifecyclePolicyGet(
        sb,
        prop,
        "TIMER_ESCALATE_RESPECT_CONTACT_HOURS",
        false
      )
    );
  }
  if (t === "AUTO_CLOSE" || t === "SEND_TENANT_VERIFY") return false;
  return false;
}

module.exports = {
  loadContactPolicy,
  tenantVerifyRespectsContactHours,
  timerTypeRespectsContactHours,
};
