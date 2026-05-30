/**
 * Vendor Agent adapter eligibility (inbound SMS/WA/TG on vendorLane).
 * Stub: always false until vendor agent ships — keeps pipeline hook explicit.
 * @see docs/VENDOR_LANE.md, docs/JARVIS_SPINE.md
 */

const { vendorAgentEnabled } = require("../../config/env");

/**
 * @param {object} o — same shape as tenant agent eligibility inputs
 * @returns {boolean}
 */
function isVendorAgentEligible(o) {
  if (!vendorAgentEnabled()) return false;
  if (!o || o.vendorRun) return false;
  const lane = String((o.laneDecision && o.laneDecision.lane) || "");
  if (lane !== "vendorLane") return false;
  if (o.staffRun || o.complianceRun || o.suppressedRun || o.stubRun) return false;
  const precursor = o.precursor || {};
  if (precursor.outcome !== "PRECURSOR_EVALUATED") return false;
  const identity = o.actorIdentity || {};
  if (identity.isVendor !== true) return false;
  return true;
}

module.exports = {
  isVendorAgentEligible,
};
