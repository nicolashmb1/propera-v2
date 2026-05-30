/**
 * Active vendor assignments for availability-only inbound (no ticket id guess when 2+).
 */

const { normalizeVendorStatus } = require("./vendorStatus");

const TERMINAL_TICKET_STATUS = new Set(["deleted", "closed", "resolved", "cancelled"]);

/**
 * @param {object} row
 * @param {string} vendorId
 */
function isActiveVendorTicketRow(row, vendorId) {
  const vid = String(vendorId || "").trim();
  if (!vid || !row) return false;
  if (row.is_imported_history === true) return false;

  const status = String(row.status || "")
    .trim()
    .toLowerCase();
  if (TERMINAL_TICKET_STATUS.has(status)) return false;

  const vs =
    normalizeVendorStatus(row.vendor_status) ||
    String(row.vendor_status || "").trim();
  if (vs.toLowerCase() === "declined") return false;

  const assigned =
    String(row.assigned_type || "").trim().toUpperCase() === "VENDOR" &&
    String(row.assigned_id || "").trim() === vid;
  const dispatched = String(row.vendor_dispatched_to || "").trim() === vid;
  if (!assigned && !dispatched) return false;

  const vsLower = vs.toLowerCase();
  return (
    !vsLower ||
    vsLower === "contacted" ||
    vsLower === "accepted" ||
    vsLower === "scheduled"
  );
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} vendorId
 * @returns {Promise<string[]>} human ticket ids, newest activity first
 */
async function listActiveHumanTicketIdsForVendor(sb, vendorId) {
  const vid = String(vendorId || "").trim();
  if (!vid) return [];

  const selectCols =
    "ticket_id, status, vendor_status, assigned_type, assigned_id, vendor_dispatched_to, is_imported_history, updated_at";

  const [assignedRes, dispatchedRes] = await Promise.all([
    sb
      .from("tickets")
      .select(selectCols)
      .eq("assigned_id", vid)
      .eq("assigned_type", "VENDOR")
      .order("updated_at", { ascending: false })
      .limit(50),
    sb
      .from("tickets")
      .select(selectCols)
      .eq("vendor_dispatched_to", vid)
      .order("updated_at", { ascending: false })
      .limit(50),
  ]);

  if (assignedRes.error && dispatchedRes.error) return [];

  const seen = new Set();
  const rows = [];
  for (const row of [...(assignedRes.data || []), ...(dispatchedRes.data || [])]) {
    const tid = String(row.ticket_id || "").trim();
    if (!tid || seen.has(tid)) continue;
    seen.add(tid);
    rows.push(row);
  }

  const ids = [];
  for (const row of rows) {
    if (!isActiveVendorTicketRow(row, vid)) continue;
    const tid = String(row.ticket_id || "").trim();
    if (tid && !ids.includes(tid)) ids.push(tid);
  }
  return ids;
}

module.exports = {
  isActiveVendorTicketRow,
  listActiveHumanTicketIdsForVendor,
};
