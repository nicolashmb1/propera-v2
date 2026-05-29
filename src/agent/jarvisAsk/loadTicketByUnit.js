/**
 * DB fallback when unit ticket is not in scope open list.
 */

const { getSupabase } = require("../../db/supabase");
const { normUnit } = require("./resolveQuestionTargets");

const CLOSED = new Set([
  "completed",
  "canceled",
  "cancelled",
  "resolved",
  "closed",
  "done",
  "deleted",
]);

function isOpenStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  if (!s) return true;
  return !CLOSED.has(s);
}

/**
 * @param {string} propertyCode
 * @param {string} unitHint
 */
async function loadOpenTicketTargetForUnit(propertyCode, unitHint) {
  const prop = String(propertyCode || "")
    .trim()
    .toUpperCase();
  const want = normUnit(unitHint);
  if (!prop || !want) return null;

  const sb = getSupabase();
  if (!sb) return null;

  const { data, error } = await sb
    .from("portal_tickets_v1")
    .select("ticket_row_id, ticket_id, unit_label, status, category_final, category")
    .eq("property_code", prop)
    .order("updated_at", { ascending: false })
    .limit(60);

  if (error || !data) return null;

  const open = data.filter(
    (row) =>
      isOpenStatus(row.status) && normUnit(row.unit_label) === want
  );
  if (!open.length) return null;
  const row = open[0];
  return {
    ticketRowId: String(row.ticket_row_id || "").trim(),
    humanTicketId: String(row.ticket_id || "").trim(),
    unitLabel: String(row.unit_label || "").trim(),
    reason: "DB_UNIT_OPEN_TICKET",
  };
}

module.exports = { loadOpenTicketTargetForUnit, isOpenStatus };
