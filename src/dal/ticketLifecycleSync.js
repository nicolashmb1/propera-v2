/**
 * GAS `lifecycleSyncTicketOnDone_` — Sheet1 Completed + closed_at (Postgres `tickets`).
 */
const { getSupabase } = require("../db/supabase");
const { mergeTicketUpdateRespectingPmOverride } = require("./ticketAssignmentGuard");
const { mergeChangedByIntoTicketPatch, lifecycleTimerActor } = require("./ticketAuditPatch");

/**
 * @param {string} ticketKey — uuid
 */
async function syncTicketRowWhenWorkItemDone(ticketKey) {
  const key = String(ticketKey || "").trim();
  if (!key) return { ok: false, error: "no_key" };
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const now = new Date().toISOString();
  const { data: ticketLockRow } = await sb
    .from("tickets")
    .select("assignment_source")
    .eq("ticket_key", key)
    .maybeSingle();

  const patch = mergeChangedByIntoTicketPatch(
    mergeTicketUpdateRespectingPmOverride(ticketLockRow || {}, {
      status: "Completed",
      closed_at: now,
      updated_at: now,
      last_activity_at: now,
    }),
    lifecycleTimerActor()
  );

  const { error } = await sb.from("tickets").update(patch).eq("ticket_key", key);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

module.exports = { syncTicketRowWhenWorkItemDone };
