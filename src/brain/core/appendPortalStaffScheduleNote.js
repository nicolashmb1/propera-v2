/**
 * Post-finalize schedule hint on receipt — staff portal / staff capture inline preferred time.
 * Optional `deps` (7th arg) merges over built-ins for tests only; production omits it.
 */
const { getSupabase } = require("../../db/supabase");
const {
  applyPreferredWindowByTicketKey,
  MIN_SCHEDULE_LEN,
  schedulePolicyRejectMessage,
} = require("../../dal/ticketPreferredWindow");
const {
  afterTenantScheduleApplied,
} = require("../lifecycle/afterTenantScheduleApplied");
const { telegramStaffCaptureActor } = require("../../dal/ticketAuditPatch");

function resolveDeps(deps) {
  const builtin = {
    applyPreferredWindowByTicketKey,
    getSupabase,
    afterTenantScheduleApplied,
    schedulePolicyRejectMessage,
  };
  return deps && typeof deps === "object" ? { ...builtin, ...deps } : builtin;
}

/**
 * @param {{ afterLifecycle?: boolean, propertyCodeHint?: string, sb?: object|null }|undefined} scheduleOpts — when `afterLifecycle`, pass core's `sb` so lifecycle uses the same DB client as the request (avoids silent skip when only `getSupabase()` would return null).
 * @param {object|undefined} deps — optional overrides for tests (merged over defaults)
 */
async function appendPortalStaffScheduleNote(
  receiptBase,
  scheduleHint,
  ticketKey,
  traceId,
  traceStartMs,
  scheduleOpts,
  deps
) {
  const {
    applyPreferredWindowByTicketKey: applyWindow,
    getSupabase: getSb,
    afterTenantScheduleApplied: afterApplied,
    schedulePolicyRejectMessage: policyRejectMsg,
  } = resolveDeps(deps);

  if (!ticketKey || String(scheduleHint || "").trim().length < MIN_SCHEDULE_LEN) {
    return receiptBase;
  }
  const scheduleActor =
    scheduleOpts && scheduleOpts.ticketChangedBy && typeof scheduleOpts.ticketChangedBy === "object"
      ? scheduleOpts.ticketChangedBy
      : telegramStaffCaptureActor();
  const applied = await applyWindow({
    ticketKey,
    preferredWindow: String(scheduleHint).trim(),
    traceId,
    traceStartMs,
    ticketChangedBy: scheduleActor,
  });
  if (applied.ok) {
    if (scheduleOpts && scheduleOpts.afterLifecycle) {
      /** Prefer caller-supplied client (core already validated DB) over a second getSupabase(). */
      const sbClient = Object.prototype.hasOwnProperty.call(scheduleOpts, "sb")
        ? scheduleOpts.sb
        : getSb();
      if (sbClient) {
        await afterApplied({
          sb: sbClient,
          ticketKey: String(ticketKey).trim(),
          parsed: applied.parsed || null,
          propertyCodeHint: String(scheduleOpts.propertyCodeHint || "").trim(),
          traceId,
          traceStartMs: traceStartMs != null ? traceStartMs : undefined,
          ticketChangedBy: scheduleActor,
        });
      }
    }
    const label =
      applied.parsed && applied.parsed.label
        ? applied.parsed.label
        : String(scheduleHint).trim();
    return `${receiptBase}\n\nPreferred time noted: ${label}.`;
  }
  if (applied.policyKey) {
    return `${receiptBase}\n\n${policyRejectMsg(applied.policyKey, applied.policyVars)}`;
  }
  return `${receiptBase}\n\n(Preferred time could not be saved; add it from the ticket when ready.)`;
}

module.exports = { appendPortalStaffScheduleNote };
