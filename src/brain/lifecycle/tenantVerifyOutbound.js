/**
 * GAS `wiEnterState_` tenant verify branch — send now or `SEND_TENANT_VERIFY` timer at contact window.
 */
const { appendEventLog } = require("../../dal/appendEventLog");
const { insertLifecycleTimer } = require("../../dal/lifecycleTimers");
const { dispatchLifecycleOutbound } = require("../../outgate/dispatchLifecycleOutbound");
const { tenantVerifyRespectsContactHours } = require("./lifecycleContactPolicy");
const {
  lifecycleIsInsideContactWindow,
  lifecycleSnapToContactWindow,
} = require("./lifecycleContactWindow");

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {object} o
 * @param {object} o.wi — work_items row
 * @param {string} o.propertyCode
 * @param {string} o.tenantPhone
 * @param {string} [o.traceId]
 */
async function sendTenantVerifyResolutionOrDefer(sb, o) {
  const wi = o.wi || {};
  const wiId = String(wi.work_item_id || "").trim();
  const prop = String(o.propertyCode || "").trim().toUpperCase() || "GLOBAL";
  const phone = String(o.tenantPhone || "").trim();
  const traceId = String(o.traceId || "").trim();

  if (!wiId || !phone) {
    await appendEventLog({
      traceId,
      log_kind: "lifecycle",
      event: "TENANT_VERIFY_SKIP_NO_PHONE",
      payload: { wi_id: wiId || null },
    });
    return { ok: false, skipped: true };
  }

  const respects = await tenantVerifyRespectsContactHours(sb, prop);
  const now = new Date();
  const inside =
    !respects || (await lifecycleIsInsideContactWindow(sb, prop, now));

  if (inside) {
    const out = await dispatchLifecycleOutbound({
      sb,
      traceId,
      templateKey: "TENANT_VERIFY_RESOLUTION",
      recipientPhoneE164: phone,
      correlationIds: {
        work_item_id: wiId,
        property_code: prop,
        ticket_key: wi.ticket_key ? String(wi.ticket_key) : "",
      },
    });
    return { ok: !!(out && out.ok), outbound: out };
  }

  const sendAt = await lifecycleSnapToContactWindow(sb, prop, now);
  const ok = await insertLifecycleTimer(sb, {
    workItemId: wiId,
    propertyCode: prop,
    timerType: "SEND_TENANT_VERIFY",
    runAt: sendAt,
    payload: { recipientPhone: phone },
    traceId,
  });

  await appendEventLog({
    traceId,
    log_kind: "lifecycle",
    event: "TENANT_VERIFY_DEFERRED_CONTACT_WINDOW",
    payload: {
      wi_id: wiId,
      run_at: sendAt.toISOString(),
      property_id: prop,
    },
  });

  return { ok, deferred: true };
}

module.exports = { sendTenantVerifyResolutionOrDefer };
