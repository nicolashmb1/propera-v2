/**
 * GAS `lifecycleWriteTimer_` runAt adjustment — `lifecycleTimerRespectsContactHours_` + snap.
 */
const { appendEventLog } = require("../../dal/appendEventLog");
const { timerTypeRespectsContactHours } = require("./lifecycleContactPolicy");
const {
  snapToContactWindow,
} = require("./lifecycleContactWindowCore");
const { loadContactPolicy } = require("./lifecycleContactPolicy");

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} propertyCode
 * @param {string} timerType
 * @param {Date} runAt
 * @param {{ traceId?: string, wiId?: string }} [o]
 */
async function maybeSnapLifecycleTimerRunAt(sb, propertyCode, timerType, runAt, o) {
  o = o || {};
  const d = runAt instanceof Date ? runAt : new Date(runAt);
  if (!isFinite(d.getTime())) return d;

  const respects = await timerTypeRespectsContactHours(
    sb,
    propertyCode,
    timerType
  );
  if (!respects) return d;

  const policy = await loadContactPolicy(sb, propertyCode);
  const snapped = snapToContactWindow(d, policy);
  if (snapped.getTime() !== d.getTime()) {
    await appendEventLog({
      traceId: o.traceId || "",
      log_kind: "lifecycle",
      event: "CONTACT_WINDOW_SNAPPED",
      payload: {
        wi_id: o.wiId || null,
        property_id: propertyCode,
        timer_type: timerType,
        run_at_requested: d.toISOString(),
        run_at_snapped: snapped.toISOString(),
      },
    });
  }
  return snapped;
}

module.exports = { maybeSnapLifecycleTimerRunAt };
