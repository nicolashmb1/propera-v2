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
 * Cancel pending timers for one work item after terminal transitions or ticket closure.
 * Idempotent: second call is a no-op. Never touches `fired` or already `cancelled` rows.
 * Stores reason and timestamp on JSON payload (`cancel_reason`, `cancelled_at`). Does not set `fired_at`.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} workItemId
 * @param {string} reason — machine-readable (e.g. `work_item_completed`, `ticket_deleted`)
 * @param {{ payloadPatch?: Record<string, unknown> }} [opts]
 * @returns {Promise<{ cancelled: number }>}
 */
async function cancelPendingLifecycleTimersForWorkItem(
  sb,
  workItemId,
  reason,
  opts
) {
  const id = String(workItemId || "").trim();
  const r = reason ? String(reason).trim() : "lifecycle_cancel";
  opts = opts || {};
  if (!sb || !id) return { cancelled: 0 };

  const nowIso = new Date().toISOString();
  const { data: rows, error } = await sb
    .from("lifecycle_timers")
    .select("id,payload")
    .eq("work_item_id", id)
    .eq("status", "pending");

  if (error || !rows || !rows.length) return { cancelled: 0 };

  let cancelled = 0;
  for (const row of rows) {
    const rowId = String(row.id || "").trim();
    if (!rowId) continue;
    const base =
      row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
        ? row.payload
        : {};
    const merged = {
      ...base,
      cancel_reason: r,
      cancelled_at: nowIso,
      ...(opts.payloadPatch && typeof opts.payloadPatch === "object"
        ? opts.payloadPatch
        : {}),
    };
    const { data: upd, error: uErr } = await sb
      .from("lifecycle_timers")
      .update({ status: "cancelled", payload: merged })
      .eq("id", rowId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (!uErr && upd && upd.id) cancelled += 1;
  }

  return { cancelled };
}

/**
 * Cancel pending timers for every work item tied to `ticket_key`.
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} ticketKey
 * @param {string} reason
 * @param {{ payloadPatch?: Record<string, unknown> }} [opts]
 * @returns {Promise<{ cancelled: number }>}
 */
async function cancelPendingLifecycleTimersForTicketKey(sb, ticketKey, reason, opts) {
  const key = String(ticketKey || "").trim();
  if (!sb || !key) return { cancelled: 0 };

  const { data: wis, error } = await sb
    .from("work_items")
    .select("work_item_id")
    .eq("ticket_key", key);

  if (error || !wis || !wis.length) return { cancelled: 0 };

  let cancelled = 0;
  for (const wi of wis) {
    const wid = wi && String(wi.work_item_id || "").trim();
    if (!wid) continue;
    const r = await cancelPendingLifecycleTimersForWorkItem(sb, wid, reason, opts);
    cancelled += r.cancelled || 0;
  }
  return { cancelled };
}

/** @deprecated Prefer cancelPendingLifecycleTimersForWorkItem with an explicit reason */
async function cancelLifecycleTimersForWorkItem(sb, wiId) {
  await cancelPendingLifecycleTimersForWorkItem(sb, wiId, "lifecycle_cancel_legacy");
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
  cancelPendingLifecycleTimersForWorkItem,
  cancelPendingLifecycleTimersForTicketKey,
  cancelLifecycleTimersForWorkItem,
  listDueLifecycleTimers,
  claimLifecycleTimer,
};
