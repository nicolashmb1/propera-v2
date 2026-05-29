/**
 * Async actor identity for lane classification — no DB from lanePolicy.js.
 * @see docs/VENDOR_LANE.md
 */

const { isDbConfigured } = require("../db/supabase");
const { resolveVendorByActorKey } = require("../dal/vendorContacts");
const { isVendorActorKey } = require("../config/lanePolicy");

/**
 * @param {object} routerParameter
 * @param {string} transportActorKey
 * @returns {Promise<{ isVendor: boolean, vendor: object | null, actorKey: string }>}
 */
async function preloadActorIdentity(routerParameter, transportActorKey) {
  const actorKey =
    String(transportActorKey || "").trim() ||
    String(routerParameter._phoneE164 || "").trim() ||
    String(routerParameter.From || "").trim();

  /** @type {{ isVendor: boolean, vendor: object | null, actorKey: string }} */
  const out = { isVendor: false, vendor: null, actorKey };

  if (isDbConfigured()) {
    const vendor = await resolveVendorByActorKey(actorKey);
    if (vendor) {
      out.isVendor = true;
      out.vendor = vendor;
      return out;
    }
  }

  if (isVendorActorKey(actorKey)) {
    out.isVendor = true;
  }
  return out;
}

module.exports = { preloadActorIdentity };
