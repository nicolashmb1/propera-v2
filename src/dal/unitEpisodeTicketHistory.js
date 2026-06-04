/**
 * Unit episode ticket history — tickets grouped under past occupancies (History tab only).
 */
const { getSupabase } = require("../db/supabase");
const { listUnitOccupancies } = require("./unitOccupancies");

function normProp(code) {
  return String(code || "").trim().toUpperCase();
}

/**
 * @param {string} createdAt
 * @param {string} startedAt
 * @param {string|null|undefined} endedAt
 */
function ticketFallsInOccupancyWindow(createdAt, startedAt, endedAt) {
  const c = new Date(createdAt).getTime();
  const s = new Date(startedAt).getTime();
  if (Number.isNaN(c) || Number.isNaN(s)) return false;
  if (c < s) return false;
  if (endedAt) {
    const e = new Date(endedAt).getTime();
    if (!Number.isNaN(e) && c > e) return false;
  }
  return true;
}

/**
 * @param {object} row
 */
function mapTicketSummary(row) {
  return {
    id: row.id,
    ticket_id: String(row.ticket_id || "").trim(),
    ticket_key: String(row.ticket_key || "").trim(),
    status: String(row.status || "").trim(),
    category: String(row.category_final || row.category || "").trim(),
    message_preview: String(row.message_raw || "").trim().slice(0, 120),
    created_at: row.created_at,
    closed_at: row.closed_at,
  };
}

/**
 * @param {{ property_code: string, unit_catalog_id: string }} q
 */
async function listUnitEpisodeTicketHistory(q) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db", episodes: [] };

  const prop = normProp(q.property_code);
  const uid = String(q.unit_catalog_id || "").trim();
  if (!prop || !uid) return { ok: false, error: "missing_property_or_unit", episodes: [] };

  const occList = await listUnitOccupancies({
    property_code: prop,
    unit_catalog_id: uid,
    status: "past",
  });
  if (!occList.ok) return { ok: false, error: occList.error || "occupancy_list_failed", episodes: [] };

  const past = occList.occupancies || [];
  if (!past.length) return { ok: true, episodes: [] };

  const { data: ticketRows, error: tErr } = await sb
    .from("tickets")
    .select(
      "id, ticket_id, ticket_key, status, category, category_final, message_raw, created_at, closed_at, unit_occupancy_id, unit_catalog_id"
    )
    .eq("unit_catalog_id", uid)
    .order("created_at", { ascending: false });

  if (tErr) return { ok: false, error: tErr.message, episodes: [] };

  const tickets = ticketRows || [];
  const episodes = past.map((occ) => {
    const occId = String(occ.id || "").trim();
    const matched = tickets.filter((t) => {
      const stampId = String(t.unit_occupancy_id || "").trim();
      if (stampId && stampId === occId) return true;
      if (stampId) return false;
      return ticketFallsInOccupancyWindow(t.created_at, occ.started_at, occ.ended_at);
    });
    return {
      occupancy: occ,
      tickets: matched.map(mapTicketSummary),
    };
  });

  return { ok: true, episodes };
}

module.exports = {
  listUnitEpisodeTicketHistory,
  ticketFallsInOccupancyWindow,
  mapTicketSummary,
};
