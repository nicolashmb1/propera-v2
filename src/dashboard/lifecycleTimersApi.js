/**
 * Ops: `lifecycle_timers` health — recent rows + status counts.
 */
const { getSupabase } = require("../db/supabase");

/**
 * @param {object} [opts]
 * @param {number} [opts.limit=150]
 * @param {string} [opts.status] — pending | fired | cancelled
 */
async function fetchLifecycleTimersForDashboard(opts) {
  opts = opts || {};
  const sb = getSupabase();
  if (!sb) {
    return { ok: false, error: "no_db", rows: [], counts: null };
  }

  const limit = Math.min(Math.max(Number(opts.limit) || 150, 1), 500);
  const status = String(opts.status || "").trim().toLowerCase();

  let q = sb
    .from("lifecycle_timers")
    .select(
      "id, work_item_id, property_code, timer_type, run_at, payload, trace_id, status, created_at, fired_at"
    )
    .order("run_at", { ascending: true })
    .limit(limit);

  if (status && ["pending", "fired", "cancelled"].includes(status)) {
    q = q.eq("status", status);
  }

  const { data: rows, error } = await q;

  if (error) {
    return { ok: false, error: error.message, rows: [], counts: null };
  }

  const counts = { pending: 0, fired: 0, cancelled: 0 };
  const statusList = ["pending", "fired", "cancelled"];
  for (const st of statusList) {
    const { count, error: cErr } = await sb
      .from("lifecycle_timers")
      .select("*", { count: "exact", head: true })
      .eq("status", st);
    if (!cErr && typeof count === "number") counts[st] = count;
  }

  return {
    ok: true,
    rows: rows || [],
    counts,
    meta: { limit, status_filter: status || null },
  };
}

module.exports = { fetchLifecycleTimersForDashboard };
