/**
 * V2 core entry — GAS routeToCoreSafe_ → handleInboundCore_ (maintenance intake).
 * Draft progression: ISSUE → PROPERTY → UNIT → FINALIZE_DRAFT (GAS `recomputeDraftExpected_` order).
 *
 * PARITY: Post-finalize **schedule ask** = flow parity (prompt + session + `pending_expected`).
 * Schedule **parsing / policy / scheduled_end_at** = NOT semantic parity — see docs/PARITY_LEDGER.md §3.
 */
const { getSupabase } = require("../../db/supabase");
const { appendEventLog } = require("../../dal/appendEventLog");
const { emit } = require("../../logging/structuredLog");
const { finalizeMaintenanceDraft } = require("../../dal/finalizeMaintenance");
const {
  getIntakeSession,
  upsertIntakeSession,
  clearIntakeSessionDraft,
  setScheduleWaitAfterFinalize,
  listPropertiesForMenu,
} = require("../../dal/intakeSession");
const { applyPreferredWindowByTicketKey, MIN_SCHEDULE_LEN } = require("../../dal/ticketPreferredWindow");
const {
  setPendingExpectedSchedule,
  clearPendingExpected,
} = require("../../dal/conversationCtxSchedule");
const { setWorkItemSubstate } = require("../../dal/workItemSubstate");
const {
  parseMaintenanceDraft,
  isMaintenanceDraftComplete,
} = require("./parseMaintenanceDraft");
const { mergeMaintenanceDraftTurn } = require("./mergeMaintenanceDraft");
const { recomputeDraftExpected } = require("./recomputeDraftExpected");
const { buildMaintenancePrompt } = require("./buildMaintenancePrompt");
const { inferEmergency } = require("../../dal/ticketDefaults");

async function loadPropertyCodesUpper(sb) {
  const { data, error } = await sb.from("properties").select("code");
  if (error || !data) return new Set();
  const set = new Set();
  data.forEach((r) => {
    if (r && r.code) set.add(String(r.code).toUpperCase());
  });
  return set;
}

function draftFlagsFromSlots(d) {
  const issue = String(d.draft_issue || "").trim();
  const prop = String(d.draft_property || "").trim();
  const unit = String(d.draft_unit || "").trim();
  const sched = String(d.draft_schedule_raw || "").trim();
  return {
    hasIssue: issue.length >= 2,
    hasProperty: !!prop,
    hasUnit: !!unit,
    hasSchedule: !!sched,
  };
}

/**
 * @param {object} o
 * @param {string} o.traceId
 * @param {Record<string, string | undefined>} o.routerParameter
 * @param {'TENANT'|'MANAGER'} o.mode
 * @param {string} o.bodyText — already stripped for staff capture
 */
async function handleInboundCore(o) {
  const traceId = o.traceId || "";
  const mode = o.mode === "MANAGER" ? "MANAGER" : "TENANT";
  const p = o.routerParameter || {};
  const actorKey =
    String(p._phoneE164 || "").trim() || String(p.From || "").trim();
  const bodyText = String(o.bodyText != null ? o.bodyText : p.Body || "").trim();
  const staffActorKey = String(o.staffActorKey || "").trim();
  const telegramUpdateId = String(p._telegramUpdateId || "").trim();

  const sb = getSupabase();
  if (!sb) {
    await appendEventLog({
      traceId,
      event: "CORE_SKIP_NO_DB",
      payload: { mode },
    });
    return {
      ok: false,
      brain: "core_skip",
      replyText: "Database is not configured; cannot create tickets in V2.",
    };
  }

  if (!actorKey) {
    return {
      ok: false,
      brain: "core_skip",
      replyText: "Missing actor (From / _phoneE164).",
    };
  }

  if (!bodyText) {
    await appendEventLog({ traceId, event: "CORE_SKIP_EMPTY_BODY", payload: { mode } });
    emit({
      level: "info",
      trace_id: traceId,
      log_kind: "brain",
      event: "CORE_SKIP_EMPTY_BODY",
      data: { mode },
    });
    return {
      ok: true,
      brain: "core_empty_body",
      replyText: "",
    };
  }

  await appendEventLog({
    traceId,
    event: "CORE_ENTER",
    payload: { mode, body_len: bodyText.length },
  });
  emit({
    level: "info",
    trace_id: traceId,
    log_kind: "brain",
    event: "CORE_ENTER",
    data: { mode, body_len: bodyText.length },
  });

  const known = await loadPropertyCodesUpper(sb);
  const propertiesList = await listPropertiesForMenu();
  const sessionAtStart = await getIntakeSession(actorKey);

  const expStart = String(
    sessionAtStart && sessionAtStart.expected != null ? sessionAtStart.expected : ""
  ).toUpperCase();
  const artifactKey = String(
    sessionAtStart && sessionAtStart.active_artifact_key != null
      ? sessionAtStart.active_artifact_key
      : ""
  ).trim();

  if (artifactKey && expStart === "SCHEDULE") {
    const mergedSched = mergeMaintenanceDraftTurn({
      bodyText,
      expected: "SCHEDULE",
      draft_issue: sessionAtStart ? sessionAtStart.draft_issue : "",
      draft_property: sessionAtStart ? sessionAtStart.draft_property : "",
      draft_unit: sessionAtStart ? sessionAtStart.draft_unit : "",
      draft_schedule_raw: sessionAtStart ? sessionAtStart.draft_schedule_raw : "",
      knownPropertyCodesUpper: known,
      propertiesList,
    });
    const schedText = String(mergedSched.draft_schedule_raw || "").trim();
    if (schedText.length >= MIN_SCHEDULE_LEN) {
      const applied = await applyPreferredWindowByTicketKey({
        ticketKey: artifactKey,
        preferredWindow: schedText,
      });
      if (!applied.ok) {
        await appendEventLog({
          traceId,
          event: "SCHEDULE_CAPTURE_FAILED",
          payload: { error: applied.error || "apply" },
        });
        return {
          ok: false,
          brain: "core_schedule_apply_failed",
          replyText: "Could not save your preferred time. Please try again in a moment.",
        };
      }
      await clearIntakeSessionDraft(actorKey);
      await clearPendingExpected(actorKey);
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
      emit({
        level: "info",
        trace_id: traceId,
        log_kind: "brain",
        event: "SCHEDULE_CAPTURED",
        data: { ticket_key: artifactKey, kind: applied.parsed && applied.parsed.kind },
      });
      return {
        ok: true,
        brain: "core_schedule_captured",
        replyText:
          "Thanks — we noted your preferred time: " +
          displayWindow +
          ". We'll follow up if we need to adjust.",
      };
    }
    return {
      ok: true,
      brain: "core_schedule_prompt_repeat",
      replyText: buildMaintenancePrompt("SCHEDULE", propertiesList),
    };
  }

  const fastDraft = parseMaintenanceDraft(bodyText, known);
  if (isMaintenanceDraftComplete(fastDraft)) {
    await appendEventLog({
      traceId,
      event: "CORE_FAST_PATH_COMPLETE",
      payload: {
        propertyCode: fastDraft.propertyCode,
        unitLabel: fastDraft.unitLabel,
        reason: "single_message_parse",
      },
    });
    emit({
      level: "info",
      trace_id: traceId,
      log_kind: "brain",
      event: "CORE_FAST_PATH_COMPLETE",
      data: { reason: "single_message_parse" },
    });

    const emFast = inferEmergency(fastDraft.issueText);
    const skipSchedulingFast = emFast.emergency === "Yes";

    const fin = await finalizeMaintenanceDraft({
      traceId,
      propertyCode: fastDraft.propertyCode,
      unitLabel: fastDraft.unitLabel,
      issueText: fastDraft.issueText,
      actorKey,
      mode,
      staffActorKey: mode === "MANAGER" ? staffActorKey || actorKey : undefined,
      telegramUpdateId,
      routerParameter: p,
    });

    await appendEventLog({
      traceId,
      event: fin.ok ? "CORE_FINALIZED" : "CORE_FINALIZE_FAILED",
      payload: fin.ok
        ? {
            ticket_id: fin.ticketId,
            work_item_id: fin.workItemId,
            ticket_key: fin.ticketKey,
            path: "fast",
          }
        : { error: fin.error },
    });
    emit({
      level: "info",
      trace_id: traceId,
      log_kind: "brain",
      event: fin.ok ? "CORE_FINALIZED" : "CORE_FINALIZE_FAILED",
      data: fin.ok
        ? { ticket_id: fin.ticketId, work_item_id: fin.workItemId, path: "fast" }
        : { error: fin.error },
    });

    if (!fin.ok) {
      return {
        ok: false,
        brain: "core_finalize_failed",
        draft: fastDraft,
        replyText: "Could not save ticket: " + (fin.error || "error"),
      };
    }

    const receiptFast =
      `Ticket logged: ${fin.ticketId} · ${fin.workItemId} (${fastDraft.propertyCode} ${fastDraft.unitLabel}). ` +
      `Key ${fin.ticketKey}.`;

    if (skipSchedulingFast) {
      await clearIntakeSessionDraft(actorKey);
      return {
        ok: true,
        brain: "core_finalized",
        draft: fastDraft,
        finalize: fin,
        path: "fast",
        replyText: receiptFast,
      };
    }

    await setScheduleWaitAfterFinalize(actorKey, {
      ticketKey: fin.ticketKey,
      draft_issue: fastDraft.issueText,
      draft_property: fastDraft.propertyCode,
      draft_unit: fastDraft.unitLabel,
    });
    await setPendingExpectedSchedule(actorKey, fin.workItemId);
    await setWorkItemSubstate(fin.workItemId, "SCHEDULE");

    await appendEventLog({
      traceId,
      event: "TICKET_CREATED_ASK_SCHEDULE",
      payload: { ticket_key: fin.ticketKey, path: "fast" },
    });
    emit({
      level: "info",
      trace_id: traceId,
      log_kind: "brain",
      event: "TICKET_CREATED_ASK_SCHEDULE",
      data: { ticket_key: fin.ticketKey, path: "fast" },
    });

    return {
      ok: true,
      brain: "core_finalized",
      draft: fastDraft,
      finalize: fin,
      path: "fast",
      replyText: receiptFast + "\n\n" + buildMaintenancePrompt("SCHEDULE", propertiesList),
    };
  }

  const session = sessionAtStart;
  const expectedSlot = String(
    session && session.expected != null ? session.expected : "ISSUE"
  ).toUpperCase();

  const merged = mergeMaintenanceDraftTurn({
    bodyText,
    expected: expectedSlot,
    draft_issue: session ? session.draft_issue : "",
    draft_property: session ? session.draft_property : "",
    draft_unit: session ? session.draft_unit : "",
    draft_schedule_raw: session ? session.draft_schedule_raw : "",
    knownPropertyCodesUpper: known,
    propertiesList,
  });

  const flags = draftFlagsFromSlots(merged);
  const em = inferEmergency(merged.draft_issue);
  const skipScheduling = em.emergency === "Yes";

  const pendingTicketRow =
    session && String(session.active_artifact_key || "").trim() ? 1 : 0;

  const rec = recomputeDraftExpected({
    hasIssue: flags.hasIssue,
    hasProperty: flags.hasProperty,
    hasUnit: flags.hasUnit,
    hasSchedule: flags.hasSchedule,
    pendingTicketRow,
    skipScheduling,
    isEmergencyContinuation: false,
  });

  const next = rec.next;

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
  emit({
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
    },
  });

  await upsertIntakeSession({
    phone_e164: actorKey,
    stage: next,
    expected: next,
    lane: "MAINTENANCE",
    draft_issue: merged.draft_issue,
    draft_property: merged.draft_property,
    draft_unit: merged.draft_unit,
    draft_schedule_raw: merged.draft_schedule_raw,
    active_artifact_key: session ? String(session.active_artifact_key || "") : "",
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
  emit({
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
    },
  });

  if (next === "FINALIZE_DRAFT") {
    const fin = await finalizeMaintenanceDraft({
      traceId,
      propertyCode: merged.draft_property,
      unitLabel: merged.draft_unit,
      issueText: merged.draft_issue,
      actorKey,
      mode,
      staffActorKey: mode === "MANAGER" ? staffActorKey || actorKey : undefined,
      telegramUpdateId,
      routerParameter: p,
    });

    await appendEventLog({
      traceId,
      event: fin.ok ? "CORE_FINALIZED" : "CORE_FINALIZE_FAILED",
      payload: fin.ok
        ? {
            ticket_id: fin.ticketId,
            work_item_id: fin.workItemId,
            ticket_key: fin.ticketKey,
            path: "multi_turn",
          }
        : { error: fin.error },
    });
    emit({
      level: "info",
      trace_id: traceId,
      log_kind: "brain",
      event: fin.ok ? "CORE_FINALIZED" : "CORE_FINALIZE_FAILED",
      data: fin.ok
        ? { ticket_id: fin.ticketId, work_item_id: fin.workItemId, path: "multi_turn" }
        : { error: fin.error },
    });

    if (!fin.ok) {
      return {
        ok: false,
        brain: "core_finalize_failed",
        draft: merged,
        replyText: "Could not save ticket: " + (fin.error || "error"),
      };
    }

    const receiptMt =
      `Ticket logged: ${fin.ticketId} · ${fin.workItemId} (${merged.draft_property} ${merged.draft_unit}). ` +
      `Key ${fin.ticketKey}.`;

    if (skipScheduling) {
      await clearIntakeSessionDraft(actorKey);
      return {
        ok: true,
        brain: "core_finalized",
        draft: merged,
        finalize: fin,
        path: "multi_turn",
        replyText: receiptMt,
      };
    }

    await setScheduleWaitAfterFinalize(actorKey, {
      ticketKey: fin.ticketKey,
      draft_issue: merged.draft_issue,
      draft_property: merged.draft_property,
      draft_unit: merged.draft_unit,
    });
    await setPendingExpectedSchedule(actorKey, fin.workItemId);
    await setWorkItemSubstate(fin.workItemId, "SCHEDULE");

    await appendEventLog({
      traceId,
      event: "TICKET_CREATED_ASK_SCHEDULE",
      payload: { ticket_key: fin.ticketKey, path: "multi_turn" },
    });
    emit({
      level: "info",
      trace_id: traceId,
      log_kind: "brain",
      event: "TICKET_CREATED_ASK_SCHEDULE",
      data: { ticket_key: fin.ticketKey, path: "multi_turn" },
    });

    return {
      ok: true,
      brain: "core_finalized",
      draft: merged,
      finalize: fin,
      path: "multi_turn",
      replyText: receiptMt + "\n\n" + buildMaintenancePrompt("SCHEDULE", propertiesList),
    };
  }

  const replyText = buildMaintenancePrompt(next, propertiesList);
  return {
    ok: true,
    brain: "core_draft_pending",
    draft: merged,
    expected: next,
    replyText,
  };
}

module.exports = { handleInboundCore };
