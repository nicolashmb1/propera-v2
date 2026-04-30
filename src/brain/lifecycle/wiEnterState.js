/**
 * GAS `wiEnterState_` — validated transition + work_items write + ticket sync on DONE.
 */
const { getWorkItemByWorkItemId } = require("../../dal/workItems");
const { isTransitionAllowed } = require("./lifecycleAllowedTransitions");
const { syncTicketRowWhenWorkItemDone } = require("../../dal/ticketLifecycleSync");
const { appendEventLog } = require("../../dal/appendEventLog");
const {
  insertLifecycleTimer,
  cancelLifecycleTimersForWorkItem,
} = require("../../dal/lifecycleTimers");
const { maybeSnapLifecycleTimerRunAt } = require("./lifecycleTimerRunAt");
const { sendTenantVerifyResolutionOrDefer } = require("./tenantVerifyOutbound");
const {
  dispatchStaffTenantNegativeFollowup,
} = require("./staffLifecycleOutbound");

function mergeMeta(existing, patch) {
  const base = existing && typeof existing === "object" ? existing : {};
  return { ...base, ...patch };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} wiId
 * @param {string} newState
 * @param {string} substate
 * @param {object} [opts]
 * @param {object} [opts.signal]
 * @param {string} [opts.traceId]
 * @param {boolean} [opts.tenantVerify]
 * @param {string} [opts.timerType]
 * @param {Date} [opts.runAt]
 * @param {object} [opts.timerPayload]
 * @param {boolean} [opts.cancelTimers] — default true
 * @param {boolean} [opts.sendStaffUpdateRequest]
 */
async function wiEnterState(sb, wiId, newState, substate, opts) {
  opts = opts || {};
  const wi = await getWorkItemByWorkItemId(wiId);
  if (!wi) return false;

  if (opts.cancelTimers !== false) {
    await cancelLifecycleTimersForWorkItem(sb, wiId);
  }

  const fromState = String(wi.state || "").trim().toUpperCase();
  const toState = String(newState || "").trim().toUpperCase();
  if (!toState) return false;

  if (!isTransitionAllowed(fromState, toState)) {
    await appendEventLog({
      traceId: opts.traceId || "",
      log_kind: "lifecycle",
      event: "WI_TRANSITION_REJECTED",
      payload: { wi_id: wiId, from: fromState, to: toState },
    });
    return false;
  }

  const prop = String(wi.property_id || "").trim().toUpperCase() || "GLOBAL";
  const snippet =
    opts.signal && opts.signal.rawText
      ? String(opts.signal.rawText).slice(0, 500)
      : "";
  const existingMeta =
    wi.metadata_json && typeof wi.metadata_json === "object" ? wi.metadata_json : {};
  const meta = mergeMeta(existingMeta, {
    staff_last_outcome_at: new Date().toISOString(),
    ...(snippet ? { staff_last_raw: snippet } : {}),
  });

  if (opts.signal && opts.signal.partsEtaText != null) {
    meta.parts_eta_text = String(opts.signal.partsEtaText || "").trim();
  }
  if (opts.signal && opts.signal.partsEtaAt instanceof Date) {
    meta.parts_eta_at = opts.signal.partsEtaAt.toISOString();
  }

  const patch = {
    state: toState,
    substate: String(substate || "").trim(),
    metadata_json: meta,
    updated_at: new Date().toISOString(),
  };
  if (toState === "DONE") patch.status = "COMPLETED";

  const { error } = await sb.from("work_items").update(patch).eq("work_item_id", wiId);

  if (error) return false;

  await appendEventLog({
    traceId: opts.traceId || "",
    log_kind: "lifecycle",
    event: "WI_TRANSITION",
    payload: { wi_id: wiId, from: fromState, to: toState, property_id: prop },
  });

  if (toState === "DONE" && wi.ticket_key) {
    await syncTicketRowWhenWorkItemDone(String(wi.ticket_key).trim());
  }

  const tenantPhone =
    (opts.signal && String(opts.signal.phone || "").trim()) ||
    String(wi.phone_e164 || "").trim();

  if (
    opts.tenantVerify &&
    toState === "VERIFYING_RESOLUTION" &&
    tenantPhone
  ) {
    const wiAfter = await getWorkItemByWorkItemId(wiId);
    await sendTenantVerifyResolutionOrDefer(sb, {
      wi: wiAfter || { ...wi, work_item_id: wiId },
      propertyCode: prop,
      tenantPhone,
      traceId: opts.traceId || "",
    });
  }

  if (opts.sendStaffUpdateRequest) {
    await appendEventLog({
      traceId: opts.traceId || "",
      log_kind: "lifecycle",
      event: "STAFF_UPDATE_REQUESTED",
      payload: { wi_id: wiId, property_id: prop },
    });
    const ownerAfter = String(
      (await getWorkItemByWorkItemId(wiId))?.owner_id ||
        wi.owner_id ||
        ""
    ).trim();
    if (ownerAfter) {
      await dispatchStaffTenantNegativeFollowup(sb, {
        traceId: opts.traceId || "",
        ownerId: ownerAfter,
        workItemId: wiId,
        propertyCode: prop,
      });
    }
  }

  if (opts.timerType && opts.runAt) {
    const payload =
      opts.timerPayload && typeof opts.timerPayload === "object"
        ? opts.timerPayload
        : {};
    let runAt = opts.runAt;
    runAt = await maybeSnapLifecycleTimerRunAt(sb, prop, opts.timerType, runAt, {
      traceId: opts.traceId,
      wiId,
    });
    const okT = await insertLifecycleTimer(sb, {
      workItemId: wiId,
      propertyCode: prop,
      timerType: opts.timerType,
      runAt,
      payload,
      traceId: opts.traceId,
    });
    if (!okT) {
      await appendEventLog({
        traceId: opts.traceId || "",
        log_kind: "lifecycle",
        event: "LIFECYCLE_TIMER_WRITE_FAIL",
        payload: {
          wi_id: wiId,
          timer_type: opts.timerType,
          run_at: opts.runAt.toISOString(),
        },
      });
    }
  }

  return true;
}

module.exports = { wiEnterState };
