/**
 * Phase 3 cross-cutting gates for `handleInboundCore` — interrupt handlers before
 * maintenance policy dispatch. Call order and payloads match the pre-extraction
 * inline implementation (characterization: `tests/scenarios/*`).
 */

const { appendEventLog } = require("../../dal/appendEventLog");
const { emitTimed } = require("../../logging/structuredLog");
const {
  getConversationCtxAttach,
  clearAttachClarifyLatch,
} = require("../../dal/conversationCtxAttach");
const { clearPendingExpected } = require("../../dal/conversationCtxSchedule");
const { parseAttachClarifyReply } = require("../gas/parseAttachClarifyReply");
const { parseMaintenanceDraftAsync } = require("./parseMaintenanceDraft");
const { mergeMaintenanceDraftTurn } = require("./mergeMaintenanceDraft");
const { recomputeDraftExpected } = require("./recomputeDraftExpected");
const {
  buildMaintenancePrompt,
  maintenanceTemplateKeyForNext,
} = require("./buildMaintenancePrompt");
const {
  MIN_SCHEDULE_LEN,
  schedulePolicyRejectMessage,
  applyPreferredWindowByTicketKey,
} = require("../../dal/ticketPreferredWindow");
const { afterTenantScheduleApplied } = require("../lifecycle/afterTenantScheduleApplied");
const {
  tryTenantVerifyResolutionReply,
} = require("../lifecycle/tryTenantVerifyResolutionReply");
const {
  draftFlagsFromSlots,
  computePendingExpiresAtIso,
} = require("./handleInboundCoreDraftHelpers");
const {
  deleteDraft,
  allocateNewDraft,
} = require("../../dal/staffCaptureDraft");
const { outgateMeta } = require("./handleInboundCoreMechanics");

/**
 * @param {object} o
 * @param {'TENANT'|'MANAGER'} o.mode
 * @param {import("@supabase/supabase-js").SupabaseClient} o.sb
 * @param {string} o.canonicalBrainActorKey
 * @param {string} o.bodyText
 * @param {string} o.traceId
 * @param {number | null} o.traceStartMs
 * @returns {Promise<{ handled: false } | { handled: true, result: object }>}
 */
async function resolveTenantVerificationIfPending(o) {
  const { mode, sb, canonicalBrainActorKey, bodyText, traceId, traceStartMs } = o;
  if (mode !== "TENANT") {
    return { handled: false };
  }
  const verifyEarly = await tryTenantVerifyResolutionReply({
    sb,
    actorKey: canonicalBrainActorKey,
    bodyText,
    traceId,
    traceStartMs,
  });
  if (verifyEarly && verifyEarly.handled) {
    return { handled: true, result: verifyEarly.result };
  }
  return { handled: false };
}

/**
 * @param {object} o
 * @param {import("@supabase/supabase-js").SupabaseClient} o.sb
 * @param {string} o.traceId
 * @param {number | null} o.traceStartMs
 * @param {string} o.canonicalBrainActorKey
 * @param {string} o.bodyText
 * @param {boolean} o.isStaffCapture
 * @param {string} o.draftOwnerKey
 * @param {number | null} o.draftSeqActive
 * @param {Set<string>} o.known
 * @param {object[]} o.propertiesList
 * @param {() => object} o.staffMetaFn
 * @param {() => Promise<unknown>} o.clearIntakeLike — tenant intake clear (not used for staff start_new)
 * @param {(row: object) => Promise<unknown>} o.saveIntakeLike
 * @returns {Promise<
 *   | { handled: false }
 *   | { handled: false, patch: { effectiveBody: string, attachClarifyOutcomePass: string } }
 *   | { handled: true, result: object }
 * >}
 */
async function resolveAttachClarifyIfPending(o) {
  const {
    sb,
    traceId,
    traceStartMs,
    canonicalBrainActorKey,
    bodyText,
    isStaffCapture,
    draftOwnerKey,
    draftSeqActive,
    known,
    propertiesList,
    staffMetaFn,
    clearIntakeLike,
    saveIntakeLike,
  } = o;

  const ctxAttach = await getConversationCtxAttach(canonicalBrainActorKey);
  if (
    !ctxAttach ||
    String(ctxAttach.pending_expected || "").trim().toUpperCase() !== "ATTACH_CLARIFY"
  ) {
    return { handled: false };
  }

  const pr = parseAttachClarifyReply(bodyText);
  if (!pr.outcome) {
    await appendEventLog({
      traceId,
      event: "ATTACH_CLARIFY_UNRESOLVED",
      payload: { len: bodyText.length },
    });
    return {
      handled: true,
      result: {
        ok: true,
        brain: "attach_clarify_repeat",
        replyText: buildMaintenancePrompt("ATTACH_CLARIFY", propertiesList),
        ...staffMetaFn(),
        ...outgateMeta(maintenanceTemplateKeyForNext("ATTACH_CLARIFY")),
      },
    };
  }

  await clearAttachClarifyLatch(canonicalBrainActorKey);
  await appendEventLog({
    traceId,
    event: "ATTACH_CLARIFY_RESOLVED",
    payload: { outcome: pr.outcome },
  });
  emitTimed(traceStartMs, {
    level: "info",
    trace_id: traceId,
    log_kind: "brain",
    event: "ATTACH_CLARIFY_RESOLVED",
    data: { outcome: pr.outcome, crumb: "attach_clarify_resolved" },
  });

  if (pr.outcome === "start_new") {
    let nextDraftSeq = draftSeqActive;
    if (isStaffCapture) {
      await deleteDraft(sb, draftOwnerKey, draftSeqActive);
      const allocSn = await allocateNewDraft(sb, draftOwnerKey);
      if (!allocSn.ok) {
        return {
          handled: true,
          result: {
            ok: false,
            brain: "staff_capture_new_draft_failed",
            replyText:
              "Could not start a new capture draft: " + (allocSn.error || "error"),
            ...staffMetaFn(),
            ...outgateMeta("MAINTENANCE_ERROR_STAFF_DRAFT"),
          },
        };
      }
      nextDraftSeq = allocSn.draftSeq;
    } else {
      await clearIntakeLike();
    }
    const restartBody =
      pr.stripped && pr.stripped.length >= 4 ? pr.stripped : "";
    const fastRestart = await parseMaintenanceDraftAsync(restartBody, known, {
      traceId,
      traceStartMs,
      propertiesList,
      mediaSignals: [],
    });
    const restarted = mergeMaintenanceDraftTurn({
      bodyText: restartBody,
      expected: "ISSUE",
      draft_issue: "",
      draft_property: "",
      draft_unit: "",
      draft_schedule_raw: "",
      draft_issue_buf_json: [],
      knownPropertyCodesUpper: known,
      propertiesList,
      parsedDraft: fastRestart,
    });
    const flagsNew = draftFlagsFromSlots(restarted);
    const recNew = recomputeDraftExpected({
      hasIssue: flagsNew.hasIssue,
      hasProperty: flagsNew.hasProperty,
      hasUnit: flagsNew.hasUnit,
      hasSchedule: flagsNew.hasSchedule,
      pendingTicketRow: 0,
      skipScheduling: false,
      isEmergencyContinuation: false,
      openerNext:
        fastRestart && fastRestart.openerNext ? fastRestart.openerNext : "",
      staffCaptureNoScheduleAsk: isStaffCapture,
    });
    const nextNew = recNew.next;
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
    const staffMetaForResult =
      isStaffCapture && nextDraftSeq != null
        ? { staffDraftSeq: nextDraftSeq }
        : staffMetaFn();
    return {
      handled: true,
      result: {
        ok: true,
        brain: "intake_start_new",
        draft: restarted,
        expected: nextNew,
        replyText: buildMaintenancePrompt(nextNew, propertiesList),
        ...staffMetaForResult,
        ...outgateMeta(maintenanceTemplateKeyForNext(nextNew)),
      },
    };
  }

  const effectiveBody =
    pr.stripped && pr.stripped.length >= 4 ? pr.stripped : bodyText;
  return {
    handled: false,
    patch: { effectiveBody, attachClarifyOutcomePass: "attach" },
  };
}

/**
 * @param {object} o
 * @param {object | null | undefined} o.sessionAtStart
 * @param {string} o.effectiveBody
 * @param {Set<string>} o.known
 * @param {object[]} o.propertiesList
 * @param {*} o.mediaSignals
 * @param {string} o.traceId
 * @param {number | null} o.traceStartMs
 * @param {boolean} o.isStaffCapture
 * @param {() => object} o.staffMetaFn
 * @param {() => Promise<unknown>} o.clearIntakeLike
 * @param {import("@supabase/supabase-js").SupabaseClient} o.sb
 * @param {string} o.canonicalBrainActorKey
 * @returns {Promise<{ handled: false } | { handled: true, result: object }>}
 */
async function handleScheduleReplyIfExpected(o) {
  const {
    sessionAtStart,
    effectiveBody,
    known,
    propertiesList,
    mediaSignals,
    traceId,
    traceStartMs,
    isStaffCapture,
    staffMetaFn,
    clearIntakeLike,
    sb,
    canonicalBrainActorKey,
  } = o;

  const expStart = String(
    sessionAtStart && sessionAtStart.expected != null ? sessionAtStart.expected : ""
  ).toUpperCase();
  const artifactKey = String(
    sessionAtStart && sessionAtStart.active_artifact_key != null
      ? sessionAtStart.active_artifact_key
      : ""
  ).trim();

  if (!(artifactKey && expStart === "SCHEDULE")) {
    return { handled: false };
  }

  await parseMaintenanceDraftAsync(effectiveBody, known, {
    traceId,
    traceStartMs,
    propertiesList,
    mediaSignals,
  });
  const mergedSched = mergeMaintenanceDraftTurn({
    bodyText: effectiveBody,
    expected: "SCHEDULE",
    draft_issue: sessionAtStart ? sessionAtStart.draft_issue : "",
    draft_property: sessionAtStart ? sessionAtStart.draft_property : "",
    draft_unit: sessionAtStart ? sessionAtStart.draft_unit : "",
    draft_schedule_raw: sessionAtStart ? sessionAtStart.draft_schedule_raw : "",
    draft_issue_buf_json: sessionAtStart ? sessionAtStart.issue_buf_json : [],
    knownPropertyCodesUpper: known,
    propertiesList,
  });
  const schedText = String(mergedSched.draft_schedule_raw || "").trim();
  if (schedText.length >= MIN_SCHEDULE_LEN) {
    const applied = await applyPreferredWindowByTicketKey({
      ticketKey: artifactKey,
      preferredWindow: schedText,
      traceId,
      traceStartMs,
    });
    if (!applied.ok) {
      if (applied.policyKey) {
        return {
          handled: true,
          result: {
            ok: true,
            brain: "core_schedule_policy_reject",
            replyText: schedulePolicyRejectMessage(
              applied.policyKey,
              applied.policyVars
            ),
            ...staffMetaFn(),
            ...outgateMeta("MAINTENANCE_SCHEDULE_POLICY_REJECT", {
              policyKey: applied.policyKey || "",
            }),
          },
        };
      }
      await appendEventLog({
        traceId,
        event: "SCHEDULE_CAPTURE_FAILED",
        payload: { error: applied.error || "apply" },
      });
      return {
        handled: true,
        result: {
          ok: false,
          brain: "core_schedule_apply_failed",
          replyText: "Could not save your preferred time. Please try again in a moment.",
          ...staffMetaFn(),
          ...outgateMeta("MAINTENANCE_ERROR_SCHEDULE_SAVE"),
        },
      };
    }
    await afterTenantScheduleApplied({
      sb,
      ticketKey: artifactKey,
      parsed: applied.parsed || null,
      propertyCodeHint: sessionAtStart
        ? String(sessionAtStart.draft_property || "").trim()
        : "",
      traceId,
      traceStartMs: traceStartMs != null ? traceStartMs : undefined,
    });
    await clearIntakeLike();
    await clearPendingExpected(canonicalBrainActorKey);
    const displayWindow =
      applied.parsed && applied.parsed.label
        ? applied.parsed.label
        : schedText;
    await appendEventLog({
      traceId,
      event: "SCHEDULE_CAPTURED",
      payload: {
        ticket_key: artifactKey,
        len: schedText.length,
        kind: applied.parsed && applied.parsed.kind,
        label: displayWindow,
      },
    });
    emitTimed(traceStartMs, {
      level: "info",
      trace_id: traceId,
      log_kind: "brain",
      event: "SCHEDULE_CAPTURED",
      data: {
        ticket_key: artifactKey,
        kind: applied.parsed && applied.parsed.kind,
        crumb: "schedule_captured",
      },
    });
    return {
      handled: true,
      result: {
        ok: true,
        brain: "core_schedule_captured",
        replyText:
          "Thanks — we noted your preferred time: " +
          displayWindow +
          ". We'll follow up if we need to adjust.",
        ...staffMetaFn(),
        ...outgateMeta("MAINTENANCE_SCHEDULE_CONFIRMED", {
          displayWindow: String(displayWindow || "").slice(0, 200),
        }),
      },
    };
  }
  if (isStaffCapture) {
    await clearIntakeLike();
    await clearPendingExpected(canonicalBrainActorKey);
    return {
      handled: true,
      result: {
        ok: true,
        brain: "core_staff_schedule_unparsed",
        replyText:
          "No time of day in that message. To add a preferred time, send a line like: Preferred: tomorrow 9am",
        ...staffMetaFn(),
        ...outgateMeta("MAINTENANCE_STAFF_NO_SCHEDULE_TEMPLATE", {}),
      },
    };
  }
  return {
    handled: true,
    result: {
      ok: true,
      brain: "core_schedule_prompt_repeat",
      replyText: buildMaintenancePrompt("SCHEDULE", propertiesList),
      ...staffMetaFn(),
      ...outgateMeta(maintenanceTemplateKeyForNext("SCHEDULE")),
    },
  };
}

module.exports = {
  resolveTenantVerificationIfPending,
  resolveAttachClarifyIfPending,
  handleScheduleReplyIfExpected,
};
