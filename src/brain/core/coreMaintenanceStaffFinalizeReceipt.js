/**
 * Phase 4 — staff `#` capture after ticket finalize when the tenant **schedule template** must not run:
 * same-message inline schedule via `appendPortalStaffScheduleNote`, else receipt-only with
 * `staff_capture_no_schedule_ask`. Callers supply precomputed `staffSchedHint` + `propertyCodeHint`.
 */

const { appendEventLog } = require("../../dal/appendEventLog");
const { MIN_SCHEDULE_LEN } = require("../../dal/ticketPreferredWindow");
const { appendPortalStaffScheduleNote } = require("./appendPortalStaffScheduleNote");
const { outgateMeta } = require("./handleInboundCoreMechanics");

/**
 * @param {object} o
 * @param {string} o.receiptText
 * @param {{ ticketKey: string }} o.fin
 * @param {string} o.traceId
 * @param {number | null} o.traceStartMs
 * @param {import("@supabase/supabase-js").SupabaseClient} o.sb
 * @param {() => object} o.staffMeta
 * @param {() => Promise<unknown>} o.clearIntakeLike
 * @param {"fast"|"multi_turn"} o.path
 * @param {object} o.draft — `fastDraft` or merged draft row (exact `draft` field on result)
 * @param {string} o.staffSchedHint — from `extractScheduleHintStaffCapture` or `extractScheduleHintStaffCaptureFromTurn`
 * @param {string} o.propertyCodeHint — `fastDraft.propertyCode` or `merged.draft_property`
 * @returns {Promise<object>} core finalized result shape
 */
async function finalizeReceiptStaffCaptureScheduleBranch(o) {
  const {
    receiptText,
    fin,
    traceId,
    traceStartMs,
    sb,
    staffMeta,
    clearIntakeLike,
    path,
    draft,
    staffSchedHint,
    propertyCodeHint,
  } = o;

  if (String(staffSchedHint).trim().length >= MIN_SCHEDULE_LEN) {
    let r = receiptText;
    r = await appendPortalStaffScheduleNote(
      r,
      staffSchedHint,
      fin.ticketKey,
      traceId,
      traceStartMs,
      {
        afterLifecycle: true,
        propertyCodeHint: String(propertyCodeHint || "").trim(),
        sb,
      }
    );
    await clearIntakeLike();
    await appendEventLog({
      traceId,
      event: "STAFF_CAPTURE_INLINE_SCHEDULE",
      payload: { ticket_key: fin.ticketKey, path },
    });
    return {
      ok: true,
      brain: "core_finalized",
      draft,
      finalize: fin,
      path,
      replyText: r,
      ...staffMeta(),
      ...outgateMeta("MAINTENANCE_RECEIPT_ONLY", {
        path,
        staff_inline_schedule: true,
      }),
    };
  }

  await clearIntakeLike();
  await appendEventLog({
    traceId,
    event: "STAFF_CAPTURE_NO_SCHEDULE_PROMPT",
    payload: { ticket_key: fin.ticketKey, path },
  });
  return {
    ok: true,
    brain: "core_finalized",
    draft,
    finalize: fin,
    path,
    replyText: receiptText,
    ...staffMeta(),
    ...outgateMeta("MAINTENANCE_RECEIPT_ONLY", {
      path,
      staff_capture_no_schedule_ask: true,
    }),
  };
}

module.exports = { finalizeReceiptStaffCaptureScheduleBranch };
