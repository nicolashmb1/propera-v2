/**
 * Controlled `tickets.vendor_status` vocabulary — @see docs/VENDOR_LANE.md
 */

const VENDOR_STATUS = Object.freeze({
  CONTACTED: "Contacted",
  ACCEPTED: "Accepted",
  DECLINED: "Declined",
  SCHEDULED: "Scheduled",
  NO_RESPONSE: "No Response",
});

const ALLOWED = new Set(Object.values(VENDOR_STATUS));

/**
 * @param {string} raw
 * @returns {string}
 */
function normalizeVendorStatus(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  for (const v of ALLOWED) {
    if (v.toLowerCase() === s.toLowerCase()) return v;
  }
  return "";
}

module.exports = {
  VENDOR_STATUS,
  ALLOWED_VENDOR_STATUSES: ALLOWED,
  normalizeVendorStatus,
};
