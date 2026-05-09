/**
 * V2 core entry — GAS routeToCoreSafe_ → handleInboundCore_ (maintenance intake).
 * Draft progression: ISSUE → PROPERTY → UNIT → FINALIZE_DRAFT (GAS `recomputeDraftExpected_` order).
 *
 * PARITY: Post-finalize **schedule ask** = flow parity for tenant (prompt + session + `pending_expected`).
 * **`#` staff capture:** never tenant schedule prompts (`SCHEDULE_PRETICKET`); same-message `compileTurn` `scheduleRaw` + `Preferred:` are parsed and applied when present (`staffCaptureNoScheduleAsk` in recompute).
 * Schedule **parsing / policy / scheduled_end_at** = NOT full GAS semantic parity — see docs/PARITY_LEDGER.md §3.
 *
 * Shape: **`buildMaintenanceCoreDispatchContext`** (load + gates + draft) → fast vs multi dispatch;
 * **`CORE_EXIT` / `CORE_ERROR`** when **`CORE_ENTER`** ran — see `coreMaintenanceBoundaryLog.js`.
 */
const { isMaintenanceDraftComplete } = require("./parseMaintenanceDraft");
const { runCoreMaintenanceFastPath } = require("./coreMaintenanceFastPath");
const { runCoreMaintenanceMultiTurn } = require("./coreMaintenanceMultiTurn");
const { buildMaintenanceCoreDispatchContext } = require("./coreMaintenanceLoadContext");
const {
  emitMaintenanceCoreExit,
  emitMaintenanceCoreError,
} = require("./coreMaintenanceBoundaryLog");

/**
 * @param {object} o
 * @param {string} o.traceId
 * @param {number} [o.traceStartMs] — `Date.now()` at HTTP entry; adds `elapsed_ms` on structured logs
 * @param {Record<string, string | undefined>} o.routerParameter
 * @param {'TENANT'|'MANAGER'} o.mode
 * @param {string} o.bodyText — already stripped for staff capture (media composed in pipeline)
 * @param {boolean} [o.isStaffCapture] — `#` staff capture lane; uses per-draft `staff_capture_drafts` (GAS D###)
 * @param {{ draftSeq: number | null, rest: string }} [o.staffDraftParsed] — from `parseStaffCapDraftIdFromStripped(bodyBase)`
 * @param {{ contact_id?: string, staff_id?: string } | null} [o.staffRow] — from `resolveStaffContextFromRouterParameter` (identity only; draft owner = canonical)
 * @param {string} [o.canonicalBrainActorKey] — signal-layer canonical actor; required for `#` staff capture (same as `routerParameter._canonicalBrainActorKey`)
 */
async function handleInboundCore(o) {
  const traceId = o.traceId || "";
  const traceStartMs =
    o.traceStartMs != null && isFinite(Number(o.traceStartMs))
      ? Number(o.traceStartMs)
      : null;

  try {
    const built = await buildMaintenanceCoreDispatchContext(o);
    if (built.kind === "return") {
      if (built.coreEntered) {
        await emitMaintenanceCoreExit(traceId, traceStartMs, built.result);
      }
      return built.result;
    }

    const ctx = built.ctx;
    let result;
    if (isMaintenanceDraftComplete(ctx.fastDraft)) {
      result = await runCoreMaintenanceFastPath({
        traceId: ctx.traceId,
        traceStartMs: ctx.traceStartMs,
        mode: ctx.mode,
        p: ctx.p,
        isStaffCapture: ctx.isStaffCapture,
        fastDraft: ctx.fastDraft,
        effectiveBody: ctx.effectiveBody,
        known: ctx.known,
        propertiesList: ctx.propertiesList,
        canonicalBrainActorKey: ctx.canonicalBrainActorKey,
        staffActorKey: ctx.staffActorKey,
        telegramUpdateId: ctx.telegramUpdateId,
        sb: ctx.sb,
        staffMeta: ctx.staffMeta,
        clearIntakeLike: ctx.clearIntakeLike,
        setScheduleWaitLike: ctx.setScheduleWaitLike,
      });
    } else {
      result = await runCoreMaintenanceMultiTurn({
        traceId: ctx.traceId,
        traceStartMs: ctx.traceStartMs,
        mode: ctx.mode,
        p: ctx.p,
        isStaffCapture: ctx.isStaffCapture,
        effectiveBody: ctx.effectiveBody,
        attachClarifyOutcomePass: ctx.attachClarifyOutcomePass,
        fastDraft: ctx.fastDraft,
        sessionAtStart: ctx.sessionAtStart,
        known: ctx.known,
        propertiesList: ctx.propertiesList,
        mediaSignals: ctx.mediaSignals,
        canonicalBrainActorKey: ctx.canonicalBrainActorKey,
        staffActorKey: ctx.staffActorKey,
        telegramUpdateId: ctx.telegramUpdateId,
        sb: ctx.sb,
        draftOwnerKey: ctx.draftOwnerKey,
        staffMeta: ctx.staffMeta,
        clearIntakeLike: ctx.clearIntakeLike,
        saveIntakeLike: ctx.saveIntakeLike,
        setScheduleWaitLike: ctx.setScheduleWaitLike,
        suppressIssueFromClarifyMedia: ctx.suppressIssueFromClarifyMedia,
        setDraftSeqActive: ctx.setDraftSeqActive,
        draftSeqActive: ctx.draftSeqActive,
      });
    }

    await emitMaintenanceCoreExit(traceId, traceStartMs, result);
    return result;
  } catch (e) {
    await emitMaintenanceCoreError(traceId, traceStartMs, e);
    throw e;
  }
}

module.exports = { handleInboundCore };
