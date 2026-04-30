/**
 * GAS `handleLifecycleSignal_` — single gateway for lifecycle events (Phase 2).
 */
const { buildLifecycleFacts } = require("./buildLifecycleFacts");
const { evaluateLifecyclePolicy } = require("./evaluateLifecyclePolicy");
const { executeLifecycleDecision } = require("./executeLifecycleDecision");
const { lifecycleEnabledForProperty } = require("../../dal/lifecyclePolicyDal");
const { getWorkItemByWorkItemId } = require("../../dal/workItems");
const { appendEventLog } = require("../../dal/appendEventLog");
const {
  normalizeLegacyWiStateForLifecycle,
} = require("./normalizeLegacyWiState");

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {object} signal
 * @param {{ traceId?: string, traceStartMs?: number }} [o]
 * @returns {Promise<{ code: string, reason?: string, key?: string, stateNow?: string }>}
 */
async function handleLifecycleSignal(sb, signal, o) {
  const traceId = o && o.traceId ? String(o.traceId) : "";
  const traceStartMs =
    o && o.traceStartMs != null && isFinite(Number(o.traceStartMs))
      ? Number(o.traceStartMs)
      : null;

  if (!sb || !signal || typeof signal !== "object") {
    return { code: "REJECTED", reason: "bad_signal" };
  }

  const eventType = String(signal.eventType || "").trim().toUpperCase();
  if (!eventType) {
    return { code: "REJECTED", reason: "missing_event_type" };
  }

  const wiId = String(signal.wiId || "").trim();
  let wi = null;
  if (wiId) {
    wi = await getWorkItemByWorkItemId(wiId);
  }

  let propertyId = String(signal.propertyId || "").trim().toUpperCase();
  if (wi && wi.property_id) {
    propertyId = String(wi.property_id).trim().toUpperCase() || propertyId;
  }
  if (!propertyId) propertyId = "GLOBAL";

  const enabled = await lifecycleEnabledForProperty(sb, propertyId);
  if (!enabled) {
    await appendEventLog({
      traceId,
      log_kind: "lifecycle",
      event: "LIFECYCLE_DISABLED",
      payload: { wi_id: wiId, property_id: propertyId, eventType },
    });
    return { code: "HOLD", reason: "LIFECYCLE_DISABLED" };
  }

  const sig = { ...signal, propertyId };
  const facts = buildLifecycleFacts(wi, sig, new Date());
  if (!facts.propertyId) facts.propertyId = propertyId;

  if (facts.currentState) {
    facts.currentState = normalizeLegacyWiStateForLifecycle(facts.currentState);
  }

  try {
    const decision = await evaluateLifecyclePolicy(sb, facts, sig, eventType);
    if (decision.decision === "HOLD") {
      return {
        code: "HOLD",
        reason: decision.reason,
        key: decision.key,
        stateNow: decision.stateNow,
      };
    }
    if (decision.decision === "REJECT") {
      return { code: "REJECTED", reason: "policy_reject" };
    }

    const execOk = await executeLifecycleDecision(sb, decision, facts, sig, {
      traceId,
      traceStartMs: traceStartMs != null ? traceStartMs : undefined,
    });
    if (execOk === false) {
      return { code: "REJECTED", reason: "execute_failed" };
    }
    return { code: "OK" };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    await appendEventLog({
      traceId,
      log_kind: "lifecycle",
      event: "LIFECYCLE_CRASH",
      payload: { error: msg, wi_id: wiId, eventType },
    });
    return { code: "CRASH", reason: msg };
  }
}

module.exports = { handleLifecycleSignal };
