/**
 * After tenant `applyPreferredWindowByTicketKey` succeeds — align WI + ticket with GAS schedule path,
 * then `ACTIVE_WORK_ENTERED` → follow-up timer policy (deferred worker today).
 */
const { handleLifecycleSignal } = require("./handleLifecycleSignal");
const { lifecycleEnabledForProperty } = require("../../dal/lifecyclePolicyDal");
const { appendEventLog } = require("../../dal/appendEventLog");
const { mergeTicketUpdateRespectingPmOverride } = require("../../dal/ticketAssignmentGuard");

/**
 * @param {object} o
 * @param {import("@supabase/supabase-js").SupabaseClient} o.sb
 * @param {string} o.ticketKey
 * @param {object|null} o.parsed — from `applyPreferredWindowByTicketKey` (`parsePreferredWindowShared` result)
 * @param {string} [o.propertyCodeHint] — draft property if WI row lacks `property_id`
 * @param {string} [o.traceId]
 * @param {number} [o.traceStartMs]
 */
async function afterTenantScheduleApplied(o) {
  const sb = o.sb;
  const ticketKey = String(o.ticketKey || "").trim();
  const traceId = String(o.traceId || "").trim();
  const traceStartMs =
    o.traceStartMs != null && isFinite(Number(o.traceStartMs))
      ? Number(o.traceStartMs)
      : null;

  if (!sb || !ticketKey) return { ok: false, error: "bad_input" };

  const parsed = o.parsed || null;
  const end =
    parsed && parsed.end instanceof Date && isFinite(parsed.end.getTime())
      ? parsed.end
      : null;

  const { data: wi, error: wiErr } = await sb
    .from("work_items")
    .select("work_item_id, property_id, state")
    .eq("ticket_key", ticketKey)
    .maybeSingle();

  if (wiErr || !wi) {
    await appendEventLog({
      traceId,
      log_kind: "lifecycle",
      event: "TENANT_SCHEDULE_LIFECYCLE_SKIP",
      payload: { ticket_key: ticketKey, reason: "wi_not_found" },
    });
    return { ok: false, error: "wi_not_found" };
  }

  const prop =
    String(wi.property_id || o.propertyCodeHint || "").trim().toUpperCase() ||
    "GLOBAL";
  const now = new Date().toISOString();

  await sb
    .from("work_items")
    .update({
      state: "ACTIVE_WORK",
      substate: "",
      updated_at: now,
    })
    .eq("work_item_id", wi.work_item_id);

  const { data: ticketLockRow } = await sb
    .from("tickets")
    .select("assignment_source")
    .eq("ticket_key", ticketKey)
    .maybeSingle();

  const tenantScheduleTicketPatch = mergeTicketUpdateRespectingPmOverride(ticketLockRow || {}, {
    status: "Scheduled",
    updated_at: now,
    last_activity_at: now,
  });

  await sb
    .from("tickets")
    .update(tenantScheduleTicketPatch)
    .eq("ticket_key", ticketKey);

  await appendEventLog({
    traceId,
    log_kind: "lifecycle",
    event: "TENANT_SCHEDULE_WI_ACTIVE_WORK",
    payload: {
      work_item_id: wi.work_item_id,
      ticket_key: ticketKey,
      property_id: prop,
    },
  });

  const enabled = await lifecycleEnabledForProperty(sb, prop);
  if (!enabled) {
    return { ok: true, lifecycle: { code: "SKIPPED", reason: "LIFECYCLE_DISABLED" } };
  }

  if (!end) {
    await appendEventLog({
      traceId,
      log_kind: "lifecycle",
      event: "ACTIVE_WORK_ENTERED_SKIPPED",
      payload: {
        wi_id: wi.work_item_id,
        reason: "no_parsed_end",
      },
    });
    return { ok: true, lifecycle: { code: "SKIPPED", reason: "no_parsed_end" } };
  }

  const lc = await handleLifecycleSignal(
    sb,
    {
      eventType: "ACTIVE_WORK_ENTERED",
      wiId: wi.work_item_id,
      propertyId: prop,
      scheduledEndAt: end,
    },
    {
      traceId,
      traceStartMs: traceStartMs != null ? traceStartMs : undefined,
    }
  );

  return { ok: true, lifecycle: lc };
}

module.exports = { afterTenantScheduleApplied };
