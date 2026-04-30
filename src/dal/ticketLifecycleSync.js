/**
 * GAS `lifecycleSyncTicketOnDone_` — Sheet1 Completed + closed_at (Postgres `tickets`).
 */
const { getSupabase } = require("../db/supabase");

/**
 * @param {string} ticketKey — uuid
 */
async function syncTicketRowWhenWorkItemDone(ticketKey) {
  const key = String(ticketKey || "").trim();
  if (!key) return { ok: false, error: "no_key" };
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const now = new Date().toISOString();
  const { error } = await sb
    .from("tickets")
    .update({
      status: "Completed",
      closed_at: now,
      updated_at: now,
      last_activity_at: now,
    })
    .eq("ticket_key", key);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

module.exports = { syncTicketRowWhenWorkItemDone };
