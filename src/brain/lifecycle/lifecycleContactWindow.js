/**
 * Async facade — GAS contact window helpers with `property_policy` reads.
 */
const {
  isInsideContactWindow,
  snapToContactWindow,
} = require("./lifecycleContactWindowCore");
const { loadContactPolicy } = require("./lifecycleContactPolicy");

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} propertyCode
 * @param {Date} date
 */
async function lifecycleIsInsideContactWindow(sb, propertyCode, date) {
  const policy = await loadContactPolicy(sb, propertyCode);
  return isInsideContactWindow(date, policy);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} propertyCode
 * @param {Date} desiredAt
 */
async function lifecycleSnapToContactWindow(sb, propertyCode, desiredAt) {
  const policy = await loadContactPolicy(sb, propertyCode);
  return snapToContactWindow(desiredAt, policy);
}

module.exports = {
  lifecycleIsInsideContactWindow,
  lifecycleSnapToContactWindow,
  isInsideContactWindow,
  snapToContactWindow,
};
