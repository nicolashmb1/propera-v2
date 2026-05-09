/**
 * Phase 4 — maintenance core policy: multi-turn draft progression (`path: multi_turn` / pending prompts).
 * Logic moved verbatim from `handleInboundCore.js` (gates + fastDraft parse already applied upstream).
 */

const { appendEventLog } = require("../../dal/appendEventLog");
const { emitTimed } = require("../../logging/structuredLog");
const { setPendingAttachClarify } = require("../../dal/conversationCtxAttach");
const { mergeMaintenanceDraftTurn } = require("./mergeMaintenanceDraft");
const { recomputeDraftExpected } = require("./recomputeDraftExpected");
const {
  buildMaintenancePrompt,
  maintenanceTemplateKeyForNext,
} = require("./buildMaintenancePrompt");
const { inferEmergency } = require("../../dal/ticketDefaults");
const {
  normalizeLocationType,
  isCommonAreaLocation,
  resolveMaintenanceDraftLocationType,
} = require("../shared/commonArea");
const {
  isPortalCreateTicketRouter,
  extractScheduleHintPortalStaffMulti,
  extractScheduleHintStaffCaptureFromTurn,
} = require("./handleInboundCoreScheduleHints");
const {
  draftFlagsFromSlots,
  computePendingExpiresAtIso,
  issueTextForFinalize,
} = require("./handleInboundCoreDraftHelpers");
const { deleteDraft, allocateNewDraft } = require("../../dal/staffCaptureDraft");
const { reconcileFinalizeTicketRows } = require("./finalizeTicketGroups");
const { appendPortalStaffScheduleNote } = require("./appendPortalStaffScheduleNote");
const {
  outgateMeta,
  coreInboundResult,
  finalizeTicketRowGroups,
  appendCoreFinalizedFlightRecorder,
  enterScheduleWaitAndLogTicketCreatedAskSchedule,
} = require("./handleInboundCoreMechanics");
const {
  resolveManagerTenantIfNeeded,
  hasClarifyingStaffMediaSignal,
  buildStaffPhotoIssueClarification,
} = require("./coreMaintenanceShared");
const {
  finalizeReceiptStaffCaptureScheduleBranch,
} = require("./coreMaintenanceStaffFinalizeReceipt");

/**
 * @param {object} x
 * @param {(seq: number) => void} x.setDraftSeqActive — staff capture `start_new` reallocates draft seq
 * @returns {Promise<object>}
 */
async function runCoreMaintenanceMultiTurn(x) {
  const {
    traceId,
    traceStartMs,
    mode,
    p,
    isStaffCapture,
    effectiveBody,
    attachClarifyOutcomePass,
    fastDraft,
    sessionAtStart,
    known,
    propertiesList,
    mediaSignals,
    canonicalBrainActorKey,
    staffActorKey,
    telegramUpdateId,
    sb,
    draftOwnerKey,
    staffMeta,
    clearIntakeLike,
    saveIntakeLike,
    setScheduleWaitLike,
    suppressIssueFromClarifyMedia,
    setDraftSeqActive,
    draftSeqActive,
  } = x;

  const session = sessionAtStart;
  const expectedSlot = String(
    session && session.expected != null ? session.expected : "ISSUE"
  ).toUpperCase();

  const merged = mergeMaintenanceDraftTurn({
    bodyText: effectiveBody,
    expected: expectedSlot,
    draft_issue: session ? session.draft_issue : "",
    draft_property: session ? session.draft_property : "",
    draft_unit: session ? session.draft_unit : "",
    draft_schedule_raw: session ? session.draft_schedule_raw : "",
    draft_issue_buf_json: session ? session.issue_buf_json : [],
    knownPropertyCodesUpper: known,
    propertiesList,
    parsedDraft: fastDraft,
    attachClarifyOutcome: attachClarifyOutcomePass || undefined,
    suppressIssueCapture: suppressIssueFromClarifyMedia,
  });

  if (merged.attachDecision === "clarify_attach_vs_new") {
    await setPendingAttachClarify(canonicalBrainActorKey);
    await appendEventLog({
      traceId,
      event: "ATTACH_CLARIFY_REQUIRED",
      payload: {
        reason: String((merged.attachReasonTags && merged.attachReasonTags[0]) || ""),
        stage: expectedSlot,
      },
    });
    return {
      ok: true,
      brain: "attach_clarify",
      draft: merged,
      replyText: buildMaintenancePrompt("ATTACH_CLARIFY", propertiesList),
      ...staffMeta(),
      ...outgateMeta(maintenanceTemplateKeyForNext("ATTACH_CLARIFY")),
    };
  }

  if (merged.attachDecision === "start_new_intake") {
    if (isStaffCapture) {
      await deleteDraft(sb, draftOwnerKey, draftSeqActive);
      const allocSn = await allocateNewDraft(sb, draftOwnerKey);
      if (!allocSn.ok) {
        return {
          ok: false,
          brain: "staff_capture_new_draft_failed",
          replyText:
            "Could not start a new capture draft: " + (allocSn.error || "error"),
          ...staffMeta(),
          ...outgateMeta("MAINTENANCE_ERROR_STAFF_DRAFT"),
        };
      }
      setDraftSeqActive(allocSn.draftSeq);
    } else {
      await clearIntakeLike();
    }
    await appendEventLog({
      traceId,
      event: "INTAKE_START_NEW",
      payload: { reason: String(merged.attachMessageRole || "") },
    });
    const restarted = mergeMaintenanceDraftTurn({
      bodyText: effectiveBody,
      expected: "ISSUE",
      draft_issue: "",
      draft_property: "",
      draft_unit: "",
      draft_schedule_raw: "",
      draft_issue_buf_json: [],
      knownPropertyCodesUpper: known,
      propertiesList,
      parsedDraft: fastDraft,
    });
    const flagsNew = draftFlagsFromSlots(restarted);
    const restartedIssueFin = issueTextForFinalize(
      restarted.draft_issue,
      restarted.draft_issue_buf_json
    );
    const restartLocType = resolveMaintenanceDraftLocationType(
      fastDraft,
      effectiveBody,
      restartedIssueFin,
      restarted.draft_issue
    );
    const restartCommon = isCommonAreaLocation(restartLocType);
    const emRestart =
      mode === "MANAGER" && isPortalCreateTicketRouter(p)
        ? { emergency: "No", emergencyType: "" }
        : inferEmergency(restartedIssueFin || restarted.draft_issue);
    const recNew = recomputeDraftExpected({
      hasIssue: flagsNew.hasIssue,
      hasProperty: flagsNew.hasProperty,
      hasUnit: restartCommon ? true : flagsNew.hasUnit,
      hasSchedule: flagsNew.hasSchedule,
      pendingTicketRow: 0,
      skipScheduling: emRestart.emergency === "Yes" || restartCommon,
      isEmergencyContinuation: false,
      openerNext: fastDraft && fastDraft.openerNext ? fastDraft.openerNext : "",
      staffCaptureNoScheduleAsk: isStaffCapture,
    });
    let nextNew = recNew.next;
    const pendingExpiresNew = computePendingExpiresAtIso(nextNew);
    await saveIntakeLike({
      phone_e164: canonicalBrainActorKey,
      stage: nextNew,
      expected: nextNew,
      lane: "MAINTENANCE",
      draft_issue: restarted.draft_issue,
      draft_property: restarted.draft_property,
      draft_unit: restarted.draft_unit,
      draft_schedule_raw: restarted.draft_schedule_raw,
      issue_buf_json: restarted.draft_issue_buf_json,
      active_artifact_key: "",
      expires_at_iso: pendingExpiresNew,
    });
    return {
      ok: true,
      brain: "intake_start_new",
      draft: restarted,
      expected: nextNew,
      replyText: buildMaintenancePrompt(nextNew, propertiesList),
      ...staffMeta(),
      ...outgateMeta(maintenanceTemplateKeyForNext(nextNew)),
    };
  }

  const flags = draftFlagsFromSlots(merged);
  const issueForFinalize = issueTextForFinalize(
    merged.draft_issue,
    merged.draft_issue_buf_json
  );
  const draftLocationType = resolveMaintenanceDraftLocationType(
    fastDraft,
    effectiveBody,
    issueForFinalize,
    merged.draft_issue
  );
  const commonAreaDraft = isCommonAreaLocation(draftLocationType);
  const em =
    mode === "MANAGER" && isPortalCreateTicketRouter(p)
      ? { emergency: "No", emergencyType: "" }
      : inferEmergency(issueForFinalize || merged.draft_issue);
  const skipScheduling = em.emergency === "Yes" || commonAreaDraft;

  const pendingTicketRow =
    session && String(session.active_artifact_key || "").trim() ? 1 : 0;

  const rec = recomputeDraftExpected({
    hasIssue: flags.hasIssue,
    hasProperty: flags.hasProperty,
    hasUnit: commonAreaDraft ? true : flags.hasUnit,
    hasSchedule: flags.hasSchedule,
    pendingTicketRow,
    skipScheduling,
    isEmergencyContinuation: false,
    openerNext:
      !commonAreaDraft && fastDraft && fastDraft.openerNext
        ? fastDraft.openerNext
        : "",
    staffCaptureNoScheduleAsk: isStaffCapture,
  });

  let next = rec.next;
  if (isStaffCapture && next === "SCHEDULE_PRETICKET") {
    next = "FINALIZE_DRAFT";
  }
  const currentStage = String(
    session && session.expected != null ? session.expected : session && session.stage != null ? session.stage : ""
  )
    .trim()
    .toUpperCase();
  if (pendingTicketRow > 0) {
    const contWhitelist = new Set(["UNIT", "SCHEDULE", "DETAIL", "EMERGENCY_DONE"]);
    if (!next) {
      next = currentStage;
    } else if (!contWhitelist.has(String(next).toUpperCase())) {
      await appendEventLog({
        traceId,
        event: "EXPECT_RECOMPUTED_BLOCKED",
        payload: {
          reason: "active_ticket_whitelist",
          next,
          current: currentStage,
        },
      });
      next = currentStage;
    }
  }
  const pendingExpiresAtIso = computePendingExpiresAtIso(next);

  await appendEventLog({
    traceId,
    event: "EXPECT_RECOMPUTED",
    payload: {
      expected: next,
      reason: "draft_completeness",
      issue: flags.hasIssue ? 1 : 0,
      prop: flags.hasProperty ? 1 : 0,
      unit: flags.hasUnit ? 1 : 0,
      sched: flags.hasSchedule ? 1 : 0,
    },
  });
  emitTimed(traceStartMs, {
    level: "info",
    trace_id: traceId,
    log_kind: "brain",
    event: "EXPECT_RECOMPUTED",
    data: {
      expected: next,
      reason: "draft_completeness",
      issue: flags.hasIssue ? 1 : 0,
      prop: flags.hasProperty ? 1 : 0,
      unit: flags.hasUnit ? 1 : 0,
      sched: flags.hasSchedule ? 1 : 0,
      crumb: "expect_recomputed",
    },
  });

  await saveIntakeLike({
    phone_e164: canonicalBrainActorKey,
    stage: next,
    expected: next,
    lane: "MAINTENANCE",
    draft_issue: merged.draft_issue,
    draft_property: merged.draft_property,
    draft_unit: merged.draft_unit,
    draft_schedule_raw: merged.draft_schedule_raw,
    issue_buf_json: merged.draft_issue_buf_json,
    active_artifact_key: session ? String(session.active_artifact_key || "") : "",
    expires_at_iso: pendingExpiresAtIso,
  });

  await appendEventLog({
    traceId,
    event: "TURN_SUMMARY",
    payload: {
      lane: "TENANT",
      mode,
      stage: next,
      expected: next,
      path: "multi_turn",
    },
  });
  emitTimed(traceStartMs, {
    level: "info",
    trace_id: traceId,
    log_kind: "brain",
    event: "TURN_SUMMARY",
    data: {
      lane: "TENANT",
      mode,
      stage: next,
      expected: next,
      path: "multi_turn",
      crumb: "turn_summary",
    },
  });

  if (next === "FINALIZE_DRAFT") {
    const trMt = await resolveManagerTenantIfNeeded(
      sb,
      mode,
      merged.draft_property,
      merged.draft_unit,
      draftLocationType,
      effectiveBody,
      p
    );

    const mergedMt = String(
      issueForFinalize || merged.draft_issue || ""
    ).trim();
    const { rows: groupsMt } = reconcileFinalizeTicketRows({
      structuredIssues: fastDraft.structuredIssues,
      mergedIssueText: mergedMt || String(effectiveBody || "").trim(),
      issueBufferLines: Array.isArray(merged.draft_issue_buf_json)
        ? merged.draft_issue_buf_json
        : [],
      effectiveBody,
    });
    const frMt = await finalizeTicketRowGroups({
      groups: groupsMt,
      buildFinalizeParams: (g) => ({
        traceId,
        propertyCode: merged.draft_property,
        unitLabel: commonAreaDraft ? "" : merged.draft_unit,
        issueText: g.issueText,
        actorKey: canonicalBrainActorKey,
        mode,
        locationType: draftLocationType,
        reportSourceUnit: merged.draft_unit,
        reportSourcePhone:
          mode === "TENANT" ? String(canonicalBrainActorKey || "").trim() : "",
        staffActorKey: mode === "MANAGER" ? staffActorKey || canonicalBrainActorKey : undefined,
        telegramUpdateId,
        routerParameter: p,
        tenantPhoneE164: trMt.tenantPhoneE164,
        tenantLookupMeta: trMt.tenantLookupMeta,
      }),
      staffMetaFn: staffMeta,
      draftOnError: merged,
      path: "multi_turn",
    });
    if (frMt.error) return frMt.error;
    const finsMt = frMt.fins;
    const fin = frMt.fin;

    await appendCoreFinalizedFlightRecorder(
      traceId,
      traceStartMs,
      finsMt,
      "multi_turn",
      "core_finalized_multi"
    );

    let receiptMt =
      finsMt.length > 1
        ? `Tickets logged: ${finsMt.map((x) => x.ticketId).join(", ")} (${merged.draft_property} ${commonAreaDraft ? "COMMON AREA" : merged.draft_unit}).`
        : `Ticket logged: ${fin.ticketId} (${merged.draft_property} ${commonAreaDraft ? "COMMON AREA" : merged.draft_unit}).`;

    const scheduleHintPortalMt =
      mode === "MANAGER" && isPortalCreateTicketRouter(p)
        ? extractScheduleHintPortalStaffMulti(merged, effectiveBody, p)
        : "";
    const skipSchedulingAfterFinalize =
      skipScheduling || (mode === "MANAGER" && isPortalCreateTicketRouter(p));

    if (skipSchedulingAfterFinalize) {
      if (scheduleHintPortalMt) {
        receiptMt = await appendPortalStaffScheduleNote(
          receiptMt,
          scheduleHintPortalMt,
          fin.ticketKey,
          traceId,
          traceStartMs
        );
      }
      await clearIntakeLike();
      return {
        ok: true,
        brain: "core_finalized",
        draft: merged,
        finalize: fin,
        path: "multi_turn",
        replyText: receiptMt,
        ...staffMeta(),
        ...outgateMeta("MAINTENANCE_RECEIPT_ONLY", {
          path: "multi_turn",
          emergency: em.emergency === "Yes",
          portalStaffCreate:
            mode === "MANAGER" && isPortalCreateTicketRouter(p) ? true : undefined,
        }),
      };
    }

    if (isStaffCapture) {
      const staffSchedHint = extractScheduleHintStaffCaptureFromTurn(
        merged,
        fastDraft,
        effectiveBody
      );
      return finalizeReceiptStaffCaptureScheduleBranch({
        receiptText: receiptMt,
        fin,
        traceId,
        traceStartMs,
        sb,
        staffMeta,
        clearIntakeLike,
        path: "multi_turn",
        draft: merged,
        staffSchedHint,
        propertyCodeHint: merged.draft_property,
      });
    }

    await enterScheduleWaitAndLogTicketCreatedAskSchedule({
      setScheduleWaitLike,
      canonicalBrainActorKey,
      fin,
      waitOpts: {
        ticketKey: fin.ticketKey,
        draft_issue: merged.draft_issue,
        issue_buf_json: merged.draft_issue_buf_json,
        draft_property: merged.draft_property,
        draft_unit: merged.draft_unit,
      },
      traceId,
      traceStartMs,
      path: "multi_turn",
    });

    return coreInboundResult(
      staffMeta,
      maintenanceTemplateKeyForNext("SCHEDULE"),
      { promptComposite: "after_receipt", path: "multi_turn" },
      {
        ok: true,
        brain: "core_finalized",
        draft: merged,
        finalize: fin,
        path: "multi_turn",
        replyText: receiptMt + "\n\n" + buildMaintenancePrompt("SCHEDULE", propertiesList),
      }
    );
  }

  const replyText = buildMaintenancePrompt(next, propertiesList);
  const staffPhotoClarify =
    isStaffCapture &&
    next === "ISSUE" &&
    hasClarifyingStaffMediaSignal(mediaSignals);
  return {
    ok: true,
    brain: "core_draft_pending",
    draft: merged,
    expected: next,
    replyText: staffPhotoClarify
      ? buildStaffPhotoIssueClarification(merged)
      : replyText,
    ...staffMeta(),
    ...outgateMeta(maintenanceTemplateKeyForNext(next), {
      staff_photo_clarify: staffPhotoClarify || undefined,
    }),
  };
}

module.exports = { runCoreMaintenanceMultiTurn };
