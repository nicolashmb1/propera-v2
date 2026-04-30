/**
 * GAS `lifecycleWriteTimer_` / `lifecycleCancelTimersForWi_` — Postgres backing store.
 */

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {object} o
 * @param {string} o.workItemId
 * @param {string} o.propertyCode
 * @param {string} o.timerType
 * @param {Date} o.runAt
 * @param {object} [o.payload]
 * @param {string} [o.traceId]
 */
async function insertLifecycleTimer(sb, o) {
  if (!sb || !o || !o.workItemId || !o.timerType || !o.runAt) return false;
  const runAt =
    o.runAt instanceof Date ? o.runAt : new Date(o.runAt);
  if (!isFinite(runAt.getTime())) return false;

  const { error } = await sb.from("lifecycle_timers").insert({
    work_item_id: String(o.workItemId).trim(),
    property_code: String(o.propertyCode || "")
      .trim()
      .toUpperCase() || "GLOBAL",
    timer_type: String(o.timerType).trim(),
    run_at: runAt.toISOString(),
    payload:
      o.payload && typeof o.payload === "object" ? o.payload : {},
    trace_id: o.traceId ? String(o.traceId).trim() : null,
    status: "pending",
  });
  return !error;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} wiId
 */
async function cancelLifecycleTimersForWorkItem(sb, wiId) {
  const id = String(wiId || "").trim();
  if (!sb || !id) return;
  await sb
    .from("lifecycle_timers")
    .update({ status: "cancelled" })
    .eq("work_item_id", id)
    .eq("status", "pending");
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {number} [limit]
 */
async function listDueLifecycleTimers(sb, limit) {
  const lim = Number(limit) > 0 ? Math.min(Number(limit), 100) : 25;
  const nowIso = new Date().toISOString();
  const { data, error } = await sb
    .from("lifecycle_timers")
    .select("*")
    .eq("status", "pending")
    .lte("run_at", nowIso)
    .order("run_at", { ascending: true })
    .limit(lim);
  if (error || !data) return [];
  return data;
}

/**
 * Mark one row fired if still pending (claim).
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} timerId — uuid
 */
async function claimLifecycleTimer(sb, timerId) {
  const id = String(timerId || "").trim();
  if (!sb || !id) return null;
  const nowIso = new Date().toISOString();
  const { data, error } = await sb
    .from("lifecycle_timers")
    .update({ status: "fired", fired_at: nowIso })
    .eq("id", id)
    .eq("status", "pending")
    .select()
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

module.exports = {
  insertLifecycleTimer,
  cancelLifecycleTimersForWorkItem,
  listDueLifecycleTimers,
  claimLifecycleTimer,
};
