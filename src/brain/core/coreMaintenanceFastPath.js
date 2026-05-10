/**
 * Phase 4 — maintenance core policy: single-turn parse complete (`path: fast`).
 * Logic moved verbatim from `handleInboundCore.js` (gates already applied upstream).
 */

const { appendEventLog } = require("../../dal/appendEventLog");
const { emitTimed } = require("../../logging/structuredLog");
const {
  normalizeLocationType,
  isCommonAreaLocation,
} = require("../shared/commonArea");
const { resolveLocationTarget } = require("../location/resolveLocationTarget");
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
const { readTurnoverIdsFromPortalPayload } = require("../../dal/turnovers");

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

  let portalPayload = {};
  try {
    portalPayload = JSON.parse(String(p._portalPayloadJson || "{}"));
  } catch (_) {
    portalPayload = {};
  }

  const locSource =
    mode === "MANAGER" && isPortalCreateTicketRouter(p)
      ? "structured_portal"
      : "draft_hints";

  const locRes = await resolveLocationTarget({
    sb,
    source: locSource,
    propertyCode: fastDraft.propertyCode,
    portalPayload: locSource === "structured_portal" ? portalPayload : undefined,
    fastDraft,
    effectiveBody,
    issueText: fastDraft.issueText,
  });

  if (!locRes.ok) {
    await appendEventLog({
      traceId,
      event: "LOCATION_TARGET_RESOLVE_FAILED",
      payload: { error_code: locRes.error_code, source: locSource },
    });
    emitTimed(traceStartMs, {
      level: "warn",
      trace_id: traceId,
      log_kind: "brain",
      event: "LOCATION_TARGET_RESOLVE_FAILED",
      data: { error_code: locRes.error_code, crumb: "location_target_resolve_failed" },
    });
    const human =
      locRes.error_code === "unknown_property"
        ? "Unknown property for ticket location."
        : locRes.error_code === "target_required"
          ? "Unit or location target is required."
          : locRes.error_code === "unknown_target"
            ? "Unknown unit or location reference."
            : locRes.error_code === "ambiguous_target"
              ? "Ambiguous unit; please clarify."
              : locRes.error_code === "invalid_target_kind"
                ? "Invalid location kind."
                : "Could not resolve ticket location.";
    const portalFail = mode === "MANAGER" && isPortalCreateTicketRouter(p);
    const brain = portalFail ? "portal_create_invalid" : "location_target_invalid";
    return {
      ok: false,
      brain,
      replyText: portalFail
        ? "Portal create_ticket failed validation: " + human
        : human,
      ...staffMeta(),
      ...outgateMeta(
        portalFail
          ? "MAINTENANCE_ERROR_PORTAL_VALIDATION"
          : "MAINTENANCE_ERROR_LOCATION_TARGET",
        { error_code: locRes.error_code }
      ),
    };
  }

  const tgt = locRes.target;
  const fastLocationType = normalizeLocationType(tgt.locationType);
  const commonAreaFast = isCommonAreaLocation(fastLocationType);
  const unitLabelResolved = String(tgt.unit_label_snapshot || "").trim();

  await appendEventLog({
    traceId,
    event: "CORE_FAST_PATH_COMPLETE",
    payload: {
      propertyCode: fastDraft.propertyCode,
      unitLabel: unitLabelResolved,
      location_kind: tgt.kind,
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
    unitLabelResolved,
    fastLocationType,
    effectiveBody,
    p
  );

  const mergedFast =
    String(fastDraft.issueText || "").trim() || String(effectiveBody || "").trim();
  const turnoverIdsFast = readTurnoverIdsFromPortalPayload(p);
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
      unitLabel: commonAreaFast ? "" : unitLabelResolved,
      issueText: g.issueText,
      actorKey: canonicalBrainActorKey,
      mode,
      locationType: fastLocationType,
      locationId: tgt.location_id || undefined,
      locationLabelSnapshot: tgt.location_label_snapshot || "",
      unitCatalogId: tgt.unit_catalog_id || undefined,
      reportSourceUnit: commonAreaFast
        ? String(fastDraft.reportSourceUnit || "").trim()
        : unitLabelResolved,
      reportSourcePhone:
        mode === "TENANT" ? String(canonicalBrainActorKey || "").trim() : "",
      staffActorKey: mode === "MANAGER" ? staffActorKey || canonicalBrainActorKey : undefined,
      telegramUpdateId,
      routerParameter: p,
      tenantPhoneE164: trFast.tenantPhoneE164,
      tenantLookupMeta: trFast.tenantLookupMeta,
      turnoverId: turnoverIdsFast.turnoverId || undefined,
      turnoverItemId: turnoverIdsFast.turnoverItemId || undefined,
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
      ? `Tickets logged: ${finsFast.map((x) => x.ticketId).join(", ")} (${fastDraft.propertyCode} ${commonAreaFast ? "COMMON AREA" : unitLabelResolved}).`
      : `Ticket logged: ${fin.ticketId} (${fastDraft.propertyCode} ${commonAreaFast ? "COMMON AREA" : unitLabelResolved}).`;

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
      draft_unit: commonAreaFast ? "" : unitLabelResolved,
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
