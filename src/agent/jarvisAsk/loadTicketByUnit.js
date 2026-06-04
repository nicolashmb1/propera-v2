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
async function loadOpenTicketTargetsForUnit(propertyCode, unitHint) {
  const prop = String(propertyCode || "")
    .trim()
    .toUpperCase();
  const want = normUnit(unitHint);
  if (!prop || !want) return [];

  const sb = getSupabase();
  if (!sb) return [];

  const { data, error } = await sb
    .from("portal_tickets_v1")
    .select(
      "ticket_row_id, ticket_id, unit_label, property_code, status, category_final, category, message_raw, created_at"
    )
    .eq("property_code", prop)
    .order("updated_at", { ascending: false })
    .limit(60);

  if (error || !data) return [];

  return data
    .filter((row) => isOpenStatus(row.status) && normUnit(row.unit_label) === want)
    .map((row) => ({
      ticketRowId: String(row.ticket_row_id || "").trim(),
      humanTicketId: String(row.ticket_id || "").trim(),
      unitLabel: String(row.unit_label || "").trim(),
      propertyCode: prop,
      category: String(row.category_final || row.category || "").trim(),
      summary: String(row.message_raw || "").trim().slice(0, 120),
      message_raw: String(row.message_raw || "").trim(),
      created_at: row.created_at || null,
    }));
}

async function loadOpenTicketTargetForUnit(propertyCode, unitHint) {
  const opens = await loadOpenTicketTargetsForUnit(propertyCode, unitHint);
  if (opens.length !== 1) return null;
  return {
    ticketRowId: opens[0].ticketRowId,
    humanTicketId: opens[0].humanTicketId,
    unitLabel: opens[0].unitLabel,
    reason: "DB_UNIT_OPEN_TICKET",
  };
}

module.exports = {
  loadOpenTicketTargetForUnit,
  loadOpenTicketTargetsForUnit,
  isOpenStatus,
};
