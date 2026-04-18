/**
 * V2 core entry — GAS routeToCoreSafe_ → handleInboundCore_ (maintenance intake).
 * Draft progression: ISSUE → PROPERTY → UNIT → FINALIZE_DRAFT (GAS `recomputeDraftExpected_` order).
 *
 * PARITY: Post-finalize **schedule ask** = flow parity (prompt + session + `pending_expected`).
 * Schedule **parsing / policy / scheduled_end_at** = NOT semantic parity — see docs/PARITY_LEDGER.md §3.
 */
const { getSupabase } = require("../../db/supabase");
const { appendEventLog } = require("../../dal/appendEventLog");
const { emitTimed } = require("../../logging/structuredLog");
const { finalizeMaintenanceDraft } = require("../../dal/finalizeMaintenance");
const {
  getIntakeSession,
  upsertIntakeSession,
  clearIntakeSessionDraft,
  setScheduleWaitAfterFinalize,
  listPropertiesForMenu,
} = require("../../dal/intakeSession");
const {
  applyPreferredWindowByTicketKey,
  MIN_SCHEDULE_LEN,
  schedulePolicyRejectMessage,
} = require("../../dal/ticketPreferredWindow");
const {
  setPendingExpectedSchedule,
  clearPendingExpected,
} = require("../../dal/conversationCtxSchedule");
const {
  setPendingAttachClarify,
  getConversationCtxAttach,
  clearAttachClarifyLatch,
} = require("../../dal/conversationCtxAttach");
const { parseAttachClarifyReply } = require("../gas/parseAttachClarifyReply");
const { setWorkItemSubstate } = require("../../dal/workItemSubstate");
const {
  parseMaintenanceDraftAsync,
  isMaintenanceDraftComplete,
} = require("./parseMaintenanceDraft");
const { mergeMaintenanceDraftTurn } = require("./mergeMaintenanceDraft");
const {
  recomputeDraftExpected,
  expiryMinutesForExpectedStage,
} = require("./recomputeDraftExpected");
const {
  buildMaintenancePrompt,
  maintenanceTemplateKeyForNext,
} = require("./buildMaintenancePrompt");
const { inferEmergency } = require("../../dal/ticketDefaults");
const { buildIssueTicketGroups } = require("./splitIssueGroups");

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
  const issueBuf = Array.isArray(d.draft_issue_buf_json) ? d.draft_issue_buf_json : [];
  const prop = String(d.draft_property || "").trim();
  const unit = String(d.draft_unit || "").trim();
  const sched = String(d.draft_schedule_raw || "").trim();
  return {
    hasIssue: issue.length >= 2 || issueBuf.length >= 1,
    hasProperty: !!prop,
    hasUnit: !!unit,
    hasSchedule: !!sched,
  };
}

function computePendingExpiresAtIso(next) {
  const mins = expiryMinutesForExpectedStage(next);
  if (mins == null) return "";
  return new Date(Date.now() + mins * 60 * 1000).toISOString();
}

function normalizeIssueForCompare(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function buildFinalizeGroups(issueText) {
  const full = normalizeIssueForCompare(issueText);
  const raw = buildIssueTicketGroups(issueText);
  const cleaned = [];
  const seen = new Set();
  for (const g of raw) {
    const txt = String(g && g.issueText ? g.issueText : "").trim();
    if (!txt) continue;
    const key = normalizeIssueForCompare(txt);
    if (!key) continue;
    // Regression guard: when split mode exists, never include the full combined issue as its own ticket.
    if (raw.length >= 2 && key === full) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ key: String(g && g.key ? g.key : ""), issueText: txt });
  }
  if (!cleaned.length) return [{ key: "single", issueText: String(issueText || "").trim() }];
  return cleaned;
}

/** Outgate hints — templateKey is stable; text still built by brain until MessageSpec bind. */
function outgateMeta(templateKey, extra) {
  return { outgate: { templateKey, ...(extra || {}) } };
}

function issueTextForFinalize(draftIssue, issueBuf) {
  const base = String(draftIssue || "").trim();
  const extras = Array.isArray(issueBuf)
    ? issueBuf.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  if (!base && !extras.length) return "";
  const seen = new Set();
  const out = [];
  for (const x of [base, ...extras]) {
    const k = normalizeIssueForCompare(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out.join(" | ").slice(0, 900);
}

/**
 * @param {object} o
 * @param {string} o.traceId
 * @param {number} [o.traceStartMs] — `Date.now()` at HTTP entry; adds `elapsed_ms` on structured logs
 * @param {Record<string, string | undefined>} o.routerParameter
 * @param {'TENANT'|'MANAGER'} o.mode
 * @param {string} o.bodyText — already stripped for staff capture
 */
async function handleInboundCore(o) {
  const traceId = o.traceId || "";
  const traceStartMs =
    o.traceStartMs != null && isFinite(Number(o.traceStartMs))
      ? Number(o.traceStartMs)
      : null;
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
      ...outgateMeta("MAINTENANCE_ERROR_DB"),
    };
  }

  if (!actorKey) {
    return {
      ok: false,
      brain: "core_skip",
      replyText: "Missing actor (From / _phoneE164).",
      ...outgateMeta("MAINTENANCE_ERROR_NO_ACTOR"),
    };
  }

  if (!bodyText) {
    await appendEventLog({ traceId, event: "CORE_SKIP_EMPTY_BODY", payload: { mode } });
    emitTimed(traceStartMs, {
      level: "info",
      trace_id: traceId,
      log_kind: "brain",
      event: "CORE_SKIP_EMPTY_BODY",
      data: { mode, crumb: "core_skip_empty_body" },
    });
    return {
      ok: true,
      brain: "core_empty_body",
      replyText: "",
      ...outgateMeta("OUTBOUND_SKIP_EMPTY"),
    };
  }

  await appendEventLog({
    traceId,
    event: "CORE_ENTER",
    payload: { mode, body_len: bodyText.length },
  });
  emitTimed(traceStartMs, {
    level: "info",
    trace_id: traceId,
    log_kind: "brain",
    event: "CORE_ENTER",
    data: { mode, body_len: bodyText.length, crumb: "core_enter" },
  });

  const known = await loadPropertyCodesUpper(sb);
  const propertiesList = await listPropertiesForMenu();
  const sessionAtStart = await getIntakeSession(actorKey);

  let effectiveBody = bodyText;
  let attachClarifyOutcomePass = "";
  const ctxAttach = await getConversationCtxAttach(actorKey);
  if (
    ctxAttach &&
    String(ctxAttach.pending_expected || "").trim().toUpperCase() === "ATTACH_CLARIFY"
  ) {
    const pr = parseAttachClarifyReply(bodyText);
    if (!pr.outcome) {
      await appendEventLog({
        traceId,
        event: "ATTACH_CLARIFY_UNRESOLVED",
        payload: { len: bodyText.length },
      });
      return {
        ok: true,
        brain: "attach_clarify_repeat",
        replyText: buildMaintenancePrompt("ATTACH_CLARIFY", propertiesList),
        ...outgateMeta(maintenanceTemplateKeyForNext("ATTACH_CLARIFY")),
      };
    }
    await clearAttachClarifyLatch(actorKey);
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
      await clearIntakeSessionDraft(actorKey);
      const restartBody =
        pr.stripped && pr.stripped.length >= 4 ? pr.stripped : "";
      const fastRestart = await parseMaintenanceDraftAsync(restartBody, known, {
        traceId,
        traceStartMs,
        propertiesList,
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
      });
      const nextNew = recNew.next;
      const pendingExpiresNew = computePendingExpiresAtIso(nextNew);
      await upsertIntakeSession({
        phone_e164: actorKey,
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
        ...outgateMeta(maintenanceTemplateKeyForNext(nextNew)),
      };
    }
    attachClarifyOutcomePass = "attach";
    effectiveBody =
      pr.stripped && pr.stripped.length >= 4 ? pr.stripped : bodyText;
  }

  const expStart = String(
    sessionAtStart && sessionAtStart.expected != null ? sessionAtStart.expected : ""
  ).toUpperCase();
  const artifactKey = String(
    sessionAtStart && sessionAtStart.active_artifact_key != null
      ? sessionAtStart.active_artifact_key
      : ""
  ).trim();

  if (artifactKey && expStart === "SCHEDULE") {
    // Same intake branch + flight recorder as fast / multi-turn path (parseMaintenanceDraft.js);
    // merge still owns schedule slot text — result not used for policy/apply.
    await parseMaintenanceDraftAsync(bodyText, known, {
      traceId,
      traceStartMs,
      propertiesList,
    });
    const mergedSched = mergeMaintenanceDraftTurn({
      bodyText,
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
            ok: true,
            brain: "core_schedule_policy_reject",
            replyText: schedulePolicyRejectMessage(
              applied.policyKey,
              applied.policyVars
            ),
            ...outgateMeta("MAINTENANCE_SCHEDULE_POLICY_REJECT", {
              policyKey: applied.policyKey || "",
            }),
          };
        }
        await appendEventLog({
          traceId,
          event: "SCHEDULE_CAPTURE_FAILED",
          payload: { error: applied.error || "apply" },
        });
        return {
          ok: false,
          brain: "core_schedule_apply_failed",
          replyText: "Could not save your preferred time. Please try again in a moment.",
          ...outgateMeta("MAINTENANCE_ERROR_SCHEDULE_SAVE"),
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
        ok: true,
        brain: "core_schedule_captured",
        replyText:
          "Thanks — we noted your preferred time: " +
          displayWindow +
          ". We'll follow up if we need to adjust.",
        ...outgateMeta("MAINTENANCE_SCHEDULE_CONFIRMED", {
          displayWindow: String(displayWindow || "").slice(0, 200),
        }),
      };
    }
    return {
      ok: true,
      brain: "core_schedule_prompt_repeat",
      replyText: buildMaintenancePrompt("SCHEDULE", propertiesList),
      ...outgateMeta(maintenanceTemplateKeyForNext("SCHEDULE")),
    };
  }

  const fastDraft = await parseMaintenanceDraftAsync(effectiveBody, known, {
    traceId,
    traceStartMs,
    propertiesList,
  });
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
    emitTimed(traceStartMs, {
      level: "info",
      trace_id: traceId,
      log_kind: "brain",
      event: "CORE_FAST_PATH_COMPLETE",
      data: { reason: "single_message_parse", crumb: "core_fast_path_complete" },
    });

    const emFast = inferEmergency(fastDraft.issueText);
    const skipSchedulingFast = emFast.emergency === "Yes";

    const groupsFast = buildFinalizeGroups(fastDraft.issueText);
    const finsFast = [];
    for (const g of groupsFast) {
      const f = await finalizeMaintenanceDraft({
        traceId,
        propertyCode: fastDraft.propertyCode,
        unitLabel: fastDraft.unitLabel,
        issueText: g.issueText,
        actorKey,
        mode,
        staffActorKey: mode === "MANAGER" ? staffActorKey || actorKey : undefined,
        telegramUpdateId,
        routerParameter: p,
      });
      if (!f.ok) {
        return {
          ok: false,
          brain: "core_finalize_failed",
          draft: fastDraft,
          replyText: "Could not save ticket: " + (f.error || "error"),
          ...outgateMeta("MAINTENANCE_ERROR_FINALIZE", {
            path: "fast",
          }),
        };
      }
      finsFast.push(f);
    }
    const fin = finsFast[0];

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
    emitTimed(traceStartMs, {
      level: "info",
      trace_id: traceId,
      log_kind: "brain",
      event: fin.ok ? "CORE_FINALIZED" : "CORE_FINALIZE_FAILED",
      data: fin.ok
        ? {
            ticket_id: fin.ticketId,
            work_item_id: fin.workItemId,
            path: "fast",
            crumb: "core_finalized_fast",
          }
        : { error: fin.error, crumb: "core_finalize_failed" },
    });

    if (!fin.ok) {
      return {
        ok: false,
        brain: "core_finalize_failed",
        draft: fastDraft,
        replyText: "Could not save ticket: " + (fin.error || "error"),
        ...outgateMeta("MAINTENANCE_ERROR_FINALIZE", { path: "fast" }),
      };
    }

    const receiptFast =
      finsFast.length > 1
        ? `Tickets logged: ${finsFast.map((x) => x.ticketId).join(", ")} (${fastDraft.propertyCode} ${fastDraft.unitLabel}).`
        : `Ticket logged: ${fin.ticketId} (${fastDraft.propertyCode} ${fastDraft.unitLabel}).`;

    if (skipSchedulingFast) {
      await clearIntakeSessionDraft(actorKey);
      return {
        ok: true,
        brain: "core_finalized",
        draft: fastDraft,
        finalize: fin,
        path: "fast",
        replyText: receiptFast,
        ...outgateMeta("MAINTENANCE_RECEIPT_ONLY", {
          path: "fast",
          emergency: true,
        }),
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
    emitTimed(traceStartMs, {
      level: "info",
      trace_id: traceId,
      log_kind: "brain",
      event: "TICKET_CREATED_ASK_SCHEDULE",
      data: {
        ticket_key: fin.ticketKey,
        path: "fast",
        crumb: "ticket_created_ask_schedule",
      },
    });

    return {
      ok: true,
      brain: "core_finalized",
      draft: fastDraft,
      finalize: fin,
      path: "fast",
      replyText: receiptFast + "\n\n" + buildMaintenancePrompt("SCHEDULE", propertiesList),
      ...outgateMeta(maintenanceTemplateKeyForNext("SCHEDULE"), {
        promptComposite: "after_receipt",
        path: "fast",
      }),
    };
  }

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
  });

  if (merged.attachDecision === "clarify_attach_vs_new") {
    await setPendingAttachClarify(actorKey);
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
      ...outgateMeta(maintenanceTemplateKeyForNext("ATTACH_CLARIFY")),
    };
  }

  if (merged.attachDecision === "start_new_intake") {
    await clearIntakeSessionDraft(actorKey);
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
    const recNew = recomputeDraftExpected({
      hasIssue: flagsNew.hasIssue,
      hasProperty: flagsNew.hasProperty,
      hasUnit: flagsNew.hasUnit,
      hasSchedule: flagsNew.hasSchedule,
      pendingTicketRow: 0,
      skipScheduling: false,
      isEmergencyContinuation: false,
      openerNext: fastDraft && fastDraft.openerNext ? fastDraft.openerNext : "",
    });
    let nextNew = recNew.next;
    const pendingExpiresNew = computePendingExpiresAtIso(nextNew);
    await upsertIntakeSession({
      phone_e164: actorKey,
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
      ...outgateMeta(maintenanceTemplateKeyForNext(nextNew)),
    };
  }

  const flags = draftFlagsFromSlots(merged);
  const issueForFinalize = issueTextForFinalize(
    merged.draft_issue,
    merged.draft_issue_buf_json
  );
  const em = inferEmergency(issueForFinalize || merged.draft_issue);
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
    openerNext: fastDraft && fastDraft.openerNext ? fastDraft.openerNext : "",
  });

  let next = rec.next;
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

  await upsertIntakeSession({
    phone_e164: actorKey,
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
    const groupsMt = buildFinalizeGroups(issueForFinalize || merged.draft_issue);
    const finsMt = [];
    for (const g of groupsMt) {
      const f = await finalizeMaintenanceDraft({
        traceId,
        propertyCode: merged.draft_property,
        unitLabel: merged.draft_unit,
        issueText: g.issueText,
        actorKey,
        mode,
        staffActorKey: mode === "MANAGER" ? staffActorKey || actorKey : undefined,
        telegramUpdateId,
        routerParameter: p,
      });
      if (!f.ok) {
        return {
          ok: false,
          brain: "core_finalize_failed",
          draft: merged,
          replyText: "Could not save ticket: " + (f.error || "error"),
          ...outgateMeta("MAINTENANCE_ERROR_FINALIZE", { path: "multi_turn" }),
        };
      }
      finsMt.push(f);
    }
    const fin = finsMt[0];

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
    emitTimed(traceStartMs, {
      level: "info",
      trace_id: traceId,
      log_kind: "brain",
      event: fin.ok ? "CORE_FINALIZED" : "CORE_FINALIZE_FAILED",
      data: fin.ok
        ? {
            ticket_id: fin.ticketId,
            work_item_id: fin.workItemId,
            path: "multi_turn",
            crumb: "core_finalized_multi",
          }
        : { error: fin.error, crumb: "core_finalize_failed" },
    });

    if (!fin.ok) {
      return {
        ok: false,
        brain: "core_finalize_failed",
        draft: merged,
        replyText: "Could not save ticket: " + (fin.error || "error"),
        ...outgateMeta("MAINTENANCE_ERROR_FINALIZE", { path: "multi_turn" }),
      };
    }

    const receiptMt =
      finsMt.length > 1
        ? `Tickets logged: ${finsMt.map((x) => x.ticketId).join(", ")} (${merged.draft_property} ${merged.draft_unit}).`
        : `Ticket logged: ${fin.ticketId} (${merged.draft_property} ${merged.draft_unit}).`;

    if (skipScheduling) {
      await clearIntakeSessionDraft(actorKey);
      return {
        ok: true,
        brain: "core_finalized",
        draft: merged,
        finalize: fin,
        path: "multi_turn",
        replyText: receiptMt,
        ...outgateMeta("MAINTENANCE_RECEIPT_ONLY", {
          path: "multi_turn",
          emergency: true,
        }),
      };
    }

    await setScheduleWaitAfterFinalize(actorKey, {
      ticketKey: fin.ticketKey,
      draft_issue: merged.draft_issue,
      issue_buf_json: merged.draft_issue_buf_json,
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
    emitTimed(traceStartMs, {
      level: "info",
      trace_id: traceId,
      log_kind: "brain",
      event: "TICKET_CREATED_ASK_SCHEDULE",
      data: {
        ticket_key: fin.ticketKey,
        path: "multi_turn",
        crumb: "ticket_created_ask_schedule",
      },
    });

    return {
      ok: true,
      brain: "core_finalized",
      draft: merged,
      finalize: fin,
      path: "multi_turn",
      replyText: receiptMt + "\n\n" + buildMaintenancePrompt("SCHEDULE", propertiesList),
      ...outgateMeta(maintenanceTemplateKeyForNext("SCHEDULE"), {
        promptComposite: "after_receipt",
        path: "multi_turn",
      }),
    };
  }

  const replyText = buildMaintenancePrompt(next, propertiesList);
  return {
    ok: true,
    brain: "core_draft_pending",
    draft: merged,
    expected: next,
    replyText,
    ...outgateMeta(maintenanceTemplateKeyForNext(next)),
  };
}

module.exports = { handleInboundCore };
