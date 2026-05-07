/**
 * Cron worker: due `lifecycle_timers` → `handleLifecycleSignal` with `TIMER_FIRE`.
 */
const { appendEventLog } = require("../dal/appendEventLog");
const {
  listDueLifecycleTimers,
  claimLifecycleTimer,
} = require("../dal/lifecycleTimers");
const { handleLifecycleSignal } = require("../brain/lifecycle/handleLifecycleSignal");

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ traceId?: string }} [o]
 */
async function processDueLifecycleTimers(sb, o) {
  o = o || {};
  const traceId = o.traceId ? String(o.traceId) : "";
  const due = await listDueLifecycleTimers(sb, 40);
  let claimedCount = 0;
  for (const row of due) {
    const claimed = await claimLifecycleTimer(sb, row.id);
    if (!claimed) continue;
    claimedCount += 1;
    const tid = claimed.trace_id ? String(claimed.trace_id).trim() : traceId;
    const r = await handleLifecycleSignal(
      sb,
      {
        eventType: "TIMER_FIRE",
        wiId: String(claimed.work_item_id || "").trim(),
        propertyId: String(claimed.property_code || "").trim().toUpperCase(),
        timerType: String(claimed.timer_type || "").trim(),
        payload:
          claimed.payload && typeof claimed.payload === "object"
            ? claimed.payload
            : {},
        actorType: "SYSTEM",
        actorId: "TIMER",
        reasonCode: "TIMER_FIRED",
      },
      { traceId: tid || traceId }
    );
    await appendEventLog({
      traceId: tid || traceId,
      log_kind: "lifecycle",
      event: "LIFECYCLE_TIMER_FIRE_HANDLED",
      payload: {
        timer_id: claimed.id,
        wi_id: claimed.work_item_id,
        timer_type: claimed.timer_type,
        code: r.code,
        reason: r.reason || null,
      },
    });
  }
  const skipped = Math.max(0, due.length - claimedCount);
  return {
    due: due.length,
    claimed: claimedCount,
    processed: claimedCount,
    skipped,
    trace_id: traceId ? traceId : null,
  };
}

module.exports = { processDueLifecycleTimers };
