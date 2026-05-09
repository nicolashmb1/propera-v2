/**
 * Phase 4 — maintenance core policy: single-turn parse complete (`path: fast`).
 * Logic moved verbatim from `handleInboundCore.js` (gates already applied upstream).
 */

const { appendEventLog } = require("../../dal/appendEventLog");
const { emitTimed } = require("../../logging/structuredLog");
const {
  normalizeLocationType,
  isCommonAreaLocation,
  resolveMaintenanceDraftLocationType,
} = require("../shared/commonArea");
const { inferEmergency } = require("../../dal/ticketDefaults");
const {
  isPortalCreateTicketRouter,
  extractScheduleHintStaffCapture,
  extractScheduleHintPortalStaff,
} = require("./handleInboundCoreScheduleHints");
const { reconcileFinalizeTicketRows } = require("./finalizeTicketGroups");
const { appendPortalStaffScheduleNote } = require("./appendPortalStaffScheduleNote");
const {
  maintenanceTemplateKeyForNext,
  buildMaintenancePrompt,
} = require("./buildMaintenancePrompt");
const {
  outgateMeta,
  coreInboundResult,
  finalizeTicketRowGroups,
  appendCoreFinalizedFlightRecorder,
  enterScheduleWaitAndLogTicketCreatedAskSchedule,
} = require("./handleInboundCoreMechanics");
const { resolveManagerTenantIfNeeded } = require("./coreMaintenanceShared");
const {
  finalizeReceiptStaffCaptureScheduleBranch,
} = require("./coreMaintenanceStaffFinalizeReceipt");

/**
 * @param {object} x
 * @returns {Promise<object>} core result shape
 */
async function runCoreMaintenanceFastPath(x) {
  const {
    traceId,
    traceStartMs,
    mode,
    p,
    isStaffCapture,
    fastDraft,
    effectiveBody,
    known,
    propertiesList,
    canonicalBrainActorKey,
    staffActorKey,
    telegramUpdateId,
    sb,
    staffMeta,
    clearIntakeLike,
    setScheduleWaitLike,
  } = x;

  await appendEventLog({
    traceId,
    event: "CORE_FAST_PATH_COMPLETE",
    payload: {
      propertyCode: fastDraft.propertyCode,
      unitLabel: fastDraft.unitLabel,
      reason:
        mode === "MANAGER" && isPortalCreateTicketRouter(p)
          ? "portal_structured_create"
          : "single_message_parse",
    },
  });
  emitTimed(traceStartMs, {
    level: "info",
    trace_id: traceId,
    log_kind: "brain",
    event: "CORE_FAST_PATH_COMPLETE",
    data: { reason: "single_message_parse", crumb: "core_fast_path_complete" },
  });

  const emFast =
    mode === "MANAGER" && isPortalCreateTicketRouter(p)
      ? { emergency: "No", emergencyType: "" }
      : inferEmergency(fastDraft.issueText);
  const fastLocationType = normalizeLocationType(
    resolveMaintenanceDraftLocationType(
      fastDraft,
      effectiveBody,
      fastDraft.issueText
    )
  );
  const commonAreaFast = isCommonAreaLocation(fastLocationType);
  const scheduleHintPortalFast =
    mode === "MANAGER" && isPortalCreateTicketRouter(p)
      ? extractScheduleHintPortalStaff(fastDraft, effectiveBody, p)
      : "";
  const skipSchedulingFast =
    emFast.emergency === "Yes" ||
    commonAreaFast ||
    (mode === "MANAGER" && isPortalCreateTicketRouter(p));

  const trFast = await resolveManagerTenantIfNeeded(
    sb,
    mode,
    fastDraft.propertyCode,
    fastDraft.unitLabel,
    fastLocationType,
    effectiveBody,
    p
  );

  const mergedFast =
    String(fastDraft.issueText || "").trim() || String(effectiveBody || "").trim();
  const { rows: groupsFast } = reconcileFinalizeTicketRows({
    structuredIssues: fastDraft.structuredIssues,
    mergedIssueText: mergedFast,
    issueBufferLines: [],
    effectiveBody,
  });
  const frFast = await finalizeTicketRowGroups({
    groups: groupsFast,
    buildFinalizeParams: (g) => ({
      traceId,
      propertyCode: fastDraft.propertyCode,
      unitLabel: commonAreaFast ? "" : fastDraft.unitLabel,
      issueText: g.issueText,
      actorKey: canonicalBrainActorKey,
      mode,
      locationType: fastLocationType,
      reportSourceUnit: fastDraft.unitLabel,
      reportSourcePhone:
        mode === "TENANT" ? String(canonicalBrainActorKey || "").trim() : "",
      staffActorKey: mode === "MANAGER" ? staffActorKey || canonicalBrainActorKey : undefined,
      telegramUpdateId,
      routerParameter: p,
      tenantPhoneE164: trFast.tenantPhoneE164,
      tenantLookupMeta: trFast.tenantLookupMeta,
    }),
    staffMetaFn: staffMeta,
    draftOnError: fastDraft,
    path: "fast",
  });
  if (frFast.error) return frFast.error;
  const finsFast = frFast.fins;
  const fin = frFast.fin;

  await appendCoreFinalizedFlightRecorder(
    traceId,
    traceStartMs,
    finsFast,
    "fast",
    "core_finalized_fast"
  );

  let receiptFast =
    finsFast.length > 1
      ? `Tickets logged: ${finsFast.map((x) => x.ticketId).join(", ")} (${fastDraft.propertyCode} ${commonAreaFast ? "COMMON AREA" : fastDraft.unitLabel}).`
      : `Ticket logged: ${fin.ticketId} (${fastDraft.propertyCode} ${commonAreaFast ? "COMMON AREA" : fastDraft.unitLabel}).`;

  if (skipSchedulingFast) {
    if (scheduleHintPortalFast) {
      receiptFast = await appendPortalStaffScheduleNote(
        receiptFast,
        scheduleHintPortalFast,
        fin.ticketKey,
        traceId,
        traceStartMs
      );
    }
    await clearIntakeLike();
    return {
      ok: true,
      brain: "core_finalized",
      draft: fastDraft,
      finalize: fin,
      path: "fast",
      replyText: receiptFast,
      ...staffMeta(),
      ...outgateMeta("MAINTENANCE_RECEIPT_ONLY", {
        path: "fast",
        emergency: emFast.emergency === "Yes",
        portalStaffCreate:
          mode === "MANAGER" && isPortalCreateTicketRouter(p) ? true : undefined,
      }),
    };
  }

  // # staff capture: parse schedule from the same message when present; never send schedule template if absent.
  if (isStaffCapture) {
    const staffSchedHint = extractScheduleHintStaffCapture(fastDraft, effectiveBody);
    return finalizeReceiptStaffCaptureScheduleBranch({
      receiptText: receiptFast,
      fin,
      traceId,
      traceStartMs,
      sb,
      staffMeta,
      clearIntakeLike,
      path: "fast",
      draft: fastDraft,
      staffSchedHint,
      propertyCodeHint: fastDraft.propertyCode,
    });
  }

  await enterScheduleWaitAndLogTicketCreatedAskSchedule({
    setScheduleWaitLike,
    canonicalBrainActorKey,
    fin,
    waitOpts: {
      ticketKey: fin.ticketKey,
      draft_issue: fastDraft.issueText,
      draft_property: fastDraft.propertyCode,
      draft_unit: fastDraft.unitLabel,
    },
    traceId,
    traceStartMs,
    path: "fast",
  });

  return coreInboundResult(
    staffMeta,
    maintenanceTemplateKeyForNext("SCHEDULE"),
    { promptComposite: "after_receipt", path: "fast" },
    {
      ok: true,
      brain: "core_finalized",
      draft: fastDraft,
      finalize: fin,
      path: "fast",
      replyText: receiptFast + "\n\n" + buildMaintenancePrompt("SCHEDULE", propertiesList),
    }
  );
}

module.exports = { runCoreMaintenanceFastPath };
