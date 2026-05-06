/**
 * V2 core entry — GAS routeToCoreSafe_ → handleInboundCore_ (maintenance intake).
 * Draft progression: ISSUE → PROPERTY → UNIT → FINALIZE_DRAFT (GAS `recomputeDraftExpected_` order).
 *
 * PARITY: Post-finalize **schedule ask** = flow parity for tenant (prompt + session + `pending_expected`).
 * **`#` staff capture:** never tenant schedule prompts (`SCHEDULE_PRETICKET`); same-message `compileTurn` `scheduleRaw` + `Preferred:` are parsed and applied when present (`staffCaptureNoScheduleAsk` in recompute).
 * Schedule **parsing / policy / scheduled_end_at** = NOT full GAS semantic parity — see docs/PARITY_LEDGER.md §3.
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
const {
  normalizeLocationType,
  isCommonAreaLocation,
  resolveMaintenanceDraftLocationType,
} = require("../shared/commonArea");
const { mergeMaintenanceDraftTurn } = require("./mergeMaintenanceDraft");
const { recomputeDraftExpected } = require("./recomputeDraftExpected");
const {
  buildMaintenancePrompt,
  maintenanceTemplateKeyForNext,
} = require("./buildMaintenancePrompt");
const { inferEmergency } = require("../../dal/ticketDefaults");
const {
  buildStructuredPortalCreateDraft,
} = require("./portalStructuredCreateDraft");
const { reconcileFinalizeTicketRows } = require("./finalizeTicketGroups");
const { parseMediaJson, composeInboundTextWithMedia } = require("../shared/mediaPayload");
const { parseMediaSignalsJson } = require("../shared/mediaSignalRuntime");
const { resolveStaffCaptureTenantPhone } = require("../../dal/tenantRoster");
const {
  afterTenantScheduleApplied,
} = require("../lifecycle/afterTenantScheduleApplied");
const {
  tryTenantVerifyResolutionReply,
} = require("../lifecycle/tryTenantVerifyResolutionReply");
const {
  parseStaffCapDraftIdFromStripped,
  resolveStaffCaptureDraftTurn,
  updateDraftFields,
  deleteDraft,
  setScheduleWaitAfterFinalizeDraft,
  allocateNewDraft,
} = require("../../dal/staffCaptureDraft");
const {
  isPortalCreateTicketRouter,
  extractScheduleHintStaffCapture,
  extractScheduleHintStaffCaptureFromTurn,
  extractScheduleHintPortalStaff,
  extractScheduleHintPortalStaffMulti,
} = require("./handleInboundCoreScheduleHints");
const {
  draftFlagsFromSlots,
  computePendingExpiresAtIso,
  issueTextForFinalize,
} = require("./handleInboundCoreDraftHelpers");
const { appendPortalStaffScheduleNote } = require("./appendPortalStaffScheduleNote");
const { hasProblemSignal } = require("./splitIssueGroups");

/**
 * GAS `enrichStaffCapTenantIdentity_` / `findTenantCandidates_` — resident phone for staff #capture only.
 */
async function resolveManagerTenantIfNeeded(
  sb,
  mode,
  propertyCode,
  unitLabel,
  locationType,
  bodyText,
  routerParameter
) {
  if (isCommonAreaLocation(locationType)) {
    return {
      tenantPhoneE164: "",
      tenantLookupMeta: { tenantLookupStatus: "SKIPPED_COMMON_AREA" },
    };
  }
  if (mode !== "MANAGER") {
    return { tenantPhoneE164: "", tenantLookupMeta: null };
  }
  const p = routerParameter || {};
  const explicitTenant = String(p._tenantPhoneE164 || "").trim();
  if (explicitTenant) {
    return {
      tenantPhoneE164: explicitTenant,
      tenantLookupMeta: { portal_explicit_tenant: true },
    };
  }
  const merged = composeInboundTextWithMedia(
    bodyText,
    parseMediaJson(p._mediaJson),
    2400,
    parseMediaSignalsJson(p._mediaSignalsJson)
  );
  const r = await resolveStaffCaptureTenantPhone({
    sb,
    propertyCode,
    unitLabel,
    bodyText: merged || bodyText,
    _mediaJson: p._mediaJson,
  });
  return {
    tenantPhoneE164: r.phoneE164 || "",
    tenantLookupMeta: r.meta || null,
  };
}

async function loadPropertyCodesUpper(sb) {
  const { data, error } = await sb.from("properties").select("code");
  if (error || !data) return new Set();
  const set = new Set();
  data.forEach((r) => {
    if (r && r.code) set.add(String(r.code).toUpperCase());
  });
  return set;
}

/** Outgate hints — templateKey is stable; text still built by brain until MessageSpec bind. */
function outgateMeta(templateKey, extra) {
  return { outgate: { templateKey, ...(extra || {}) } };
}

function hasClarifyingStaffMediaSignal(mediaSignals) {
  const list = Array.isArray(mediaSignals) ? mediaSignals : [];
  return list.some((sig) => {
    if (!sig || typeof sig !== "object") return false;
    if (sig.needsClarification) return true;
    const issueConf =
      sig.confidence && typeof sig.confidence === "object"
        ? Number(sig.confidence.issue)
        : 0;
    const hasIssueText = !!String(
      sig.syntheticBody || sig.issueNameHint || sig.issueDescriptionHint || ""
    ).trim();
    return !hasIssueText && isFinite(issueConf) && issueConf > 0 && issueConf < 0.55;
  });
}

function buildStaffPhotoIssueClarification(draft) {
  const prop = String(draft && draft.draft_property || "").trim();
  const unit = String(draft && draft.draft_unit || "").trim();
  const place = [prop, unit].filter(Boolean).join(" ");
  if (place) {
    return "I received the photo for " + place + ". What issue should I create this for?";
  }
  return "I received the photo. What issue should I create this for?";
}

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
  const mode = o.mode === "MANAGER" ? "MANAGER" : "TENANT";
  const isStaffCapture = o.isStaffCapture === true;
  const p = o.routerParameter || {};
  const transportActorKey =
    String(p._phoneE164 || "").trim() || String(p.From || "").trim();
  const explicitCanonical = String(
    o.canonicalBrainActorKey != null && o.canonicalBrainActorKey !== ""
      ? o.canonicalBrainActorKey
      : p._canonicalBrainActorKey || ""
  ).trim();
  /** Tenant / non–staff-capture: may fall back to transport. Staff `#` capture: never use transport here — see checks below. */
  const canonicalBrainActorKey = isStaffCapture
    ? explicitCanonical
    : explicitCanonical || transportActorKey;
  let bodyText = String(o.bodyText != null ? o.bodyText : p.Body || "").trim();
  const mediaSignals = parseMediaSignalsJson(p._mediaSignalsJson);
  /** Populated after staff draft resolve — `staffDraftSeq` on core results for D### tagging in pipeline. */
  let staffMeta = () => ({});
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
      ...staffMeta(), ...outgateMeta("MAINTENANCE_ERROR_DB"),
    };
  }

  if (isStaffCapture && !explicitCanonical) {
    return {
      ok: false,
      brain: "core_skip",
      replyText: "Missing canonical brain actor key for staff capture.",
      ...staffMeta(), ...outgateMeta("MAINTENANCE_ERROR_NO_ACTOR"),
    };
  }

  if (!canonicalBrainActorKey) {
    return {
      ok: false,
      brain: "core_skip",
      replyText: "Missing actor (From / _phoneE164).",
      ...staffMeta(), ...outgateMeta("MAINTENANCE_ERROR_NO_ACTOR"),
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
      ...staffMeta(), ...outgateMeta("OUTBOUND_SKIP_EMPTY"),
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

  /** Staff # drafts: owner key = signal-layer `canonicalBrainActorKey` only (never raw transport). */
  const draftOwnerKey = isStaffCapture ? explicitCanonical : canonicalBrainActorKey;

  if (isStaffCapture) {
    if (draftOwnerKey !== explicitCanonical) {
      emitTimed(traceStartMs, {
        level: "error",
        trace_id: traceId,
        log_kind: "brain",
        event: "STAFF_CAPTURE_CANONICAL_INVARIANT_VIOLATION",
        data: {
          crumb: "staff_capture_canonical_invariant",
          draftOwnerKey,
          explicitCanonical,
          transportActorKey,
          mode,
        },
      });
      return {
        ok: false,
        brain: "core_invariant_canonical_mismatch",
        replyText: "Internal error: staff capture canonical identity mismatch.",
        ...staffMeta(),
        ...outgateMeta("MAINTENANCE_ERROR_NO_ACTOR"),
      };
    }
    emitTimed(traceStartMs, {
      level: "info",
      trace_id: traceId,
      log_kind: "brain",
      event: "STAFF_CAPTURE_CANONICAL_OK",
      data: {
        crumb: "staff_capture_canonical_ok",
        draft_owner_key: draftOwnerKey,
        transport_actor_key: transportActorKey,
        staff_id: o.staffRow && o.staffRow.staff_id ? String(o.staffRow.staff_id) : "",
      },
    });
  }

  let draftSeqActive = null;
  let sessionAtStart;
  let staffTypedPayload = "";
  if (isStaffCapture) {
    const parsed =
      o.staffDraftParsed && typeof o.staffDraftParsed === "object"
        ? o.staffDraftParsed
        : parseStaffCapDraftIdFromStripped("");
    staffTypedPayload = String(parsed.rest || "").trim();
    const resolved = await resolveStaffCaptureDraftTurn(
      sb,
      draftOwnerKey,
      parsed,
      bodyText
    );
    if (!resolved.ok) {
      return {
        ok: false,
        brain: "staff_capture_draft_resolve_failed",
        replyText: resolved.error,
        ...staffMeta(), ...outgateMeta("MAINTENANCE_ERROR_STAFF_DRAFT"),
      };
    }
    draftSeqActive = resolved.draftSeq;
    sessionAtStart = resolved.session;
    bodyText = resolved.effectiveBody;
  } else {
    sessionAtStart = await getIntakeSession(canonicalBrainActorKey);
  }

  staffMeta = () =>
    isStaffCapture && draftSeqActive != null
      ? { staffDraftSeq: draftSeqActive }
      : {};

  async function clearIntakeLike() {
    if (isStaffCapture) {
      return deleteDraft(sb, draftOwnerKey, draftSeqActive);
    }
    return clearIntakeSessionDraft(canonicalBrainActorKey);
  }

  async function saveIntakeLike(row) {
    if (isStaffCapture) {
      const { phone_e164: _p, lane: _l, ...rest } = row;
      return updateDraftFields(sb, draftOwnerKey, draftSeqActive, rest);
    }
    return upsertIntakeSession(row);
  }

  async function setScheduleWaitLike(opts) {
    if (isStaffCapture) {
      return setScheduleWaitAfterFinalizeDraft(sb, draftOwnerKey, draftSeqActive, opts);
    }
    return setScheduleWaitAfterFinalize(canonicalBrainActorKey, opts);
  }

  if (mode === "TENANT") {
    const verifyEarly = await tryTenantVerifyResolutionReply({
      sb,
      actorKey: canonicalBrainActorKey,
      bodyText,
      traceId,
      traceStartMs,
    });
    if (verifyEarly && verifyEarly.handled) {
      return verifyEarly.result;
    }
  }

  let effectiveBody = bodyText;
  let attachClarifyOutcomePass = "";
  const ctxAttach = await getConversationCtxAttach(canonicalBrainActorKey);
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
        ...staffMeta(), ...outgateMeta(maintenanceTemplateKeyForNext("ATTACH_CLARIFY")),
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
      if (isStaffCapture) {
        await deleteDraft(sb, draftOwnerKey, draftSeqActive);
        const allocSn = await allocateNewDraft(sb, draftOwnerKey);
        if (!allocSn.ok) {
          return {
            ok: false,
            brain: "staff_capture_new_draft_failed",
            replyText:
              "Could not start a new capture draft: " + (allocSn.error || "error"),
            ...staffMeta(), ...outgateMeta("MAINTENANCE_ERROR_STAFF_DRAFT"),
          };
        }
        draftSeqActive = allocSn.draftSeq;
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
      return {
        ok: true,
        brain: "intake_start_new",
        draft: restarted,
        expected: nextNew,
        replyText: buildMaintenancePrompt(nextNew, propertiesList),
        ...staffMeta(), ...outgateMeta(maintenanceTemplateKeyForNext(nextNew)),
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
            ok: true,
            brain: "core_schedule_policy_reject",
            replyText: schedulePolicyRejectMessage(
              applied.policyKey,
              applied.policyVars
            ),
            ...staffMeta(), ...outgateMeta("MAINTENANCE_SCHEDULE_POLICY_REJECT", {
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
          ...staffMeta(), ...outgateMeta("MAINTENANCE_ERROR_SCHEDULE_SAVE"),
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
        ok: true,
        brain: "core_schedule_captured",
        replyText:
          "Thanks — we noted your preferred time: " +
          displayWindow +
          ". We'll follow up if we need to adjust.",
        ...staffMeta(), ...outgateMeta("MAINTENANCE_SCHEDULE_CONFIRMED", {
          displayWindow: String(displayWindow || "").slice(0, 200),
        }),
      };
    }
    if (isStaffCapture) {
      await clearIntakeLike();
      await clearPendingExpected(canonicalBrainActorKey);
      return {
        ok: true,
        brain: "core_staff_schedule_unparsed",
        replyText:
          "No time of day in that message. To add a preferred time, send a line like: Preferred: tomorrow 9am",
        ...staffMeta(), ...outgateMeta("MAINTENANCE_STAFF_NO_SCHEDULE_TEMPLATE", {}),
      };
    }
    return {
      ok: true,
      brain: "core_schedule_prompt_repeat",
      replyText: buildMaintenancePrompt("SCHEDULE", propertiesList),
      ...staffMeta(), ...outgateMeta(maintenanceTemplateKeyForNext("SCHEDULE")),
    };
  }

  let fastDraft;
  if (mode === "MANAGER" && isPortalCreateTicketRouter(p)) {
    const structured = buildStructuredPortalCreateDraft(p, known, propertiesList);
    if (!structured) {
      await appendEventLog({
        traceId,
        event: "PORTAL_CREATE_VALIDATION_FAILED",
        payload: { mode },
      });
      emitTimed(traceStartMs, {
        level: "warn",
        trace_id: traceId,
        log_kind: "brain",
        event: "PORTAL_CREATE_VALIDATION_FAILED",
        data: { crumb: "portal_create_validation_failed" },
      });
      return {
        ok: false,
        brain: "portal_create_invalid",
        replyText:
          "Portal create_ticket failed validation: unknown property, or missing unit/message.",
        ...staffMeta(),
        ...outgateMeta("MAINTENANCE_ERROR_PORTAL_VALIDATION", {}),
      };
    }
    fastDraft = structured;
  } else {
    fastDraft = await parseMaintenanceDraftAsync(effectiveBody, known, {
      traceId,
      traceStartMs,
      propertiesList,
      mediaSignals,
    });
  }
  const suppressIssueFromClarifyMedia =
    isStaffCapture &&
    hasClarifyingStaffMediaSignal(mediaSignals) &&
    !hasProblemSignal(staffTypedPayload);
  if (suppressIssueFromClarifyMedia) {
    fastDraft.issueText = "";
    fastDraft.structuredIssues = null;
    if (fastDraft.openerNext === "SCHEDULE") fastDraft.openerNext = "";
  }
  if (isMaintenanceDraftComplete(fastDraft)) {
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
    const finsFast = [];
    for (const g of groupsFast) {
      const f = await finalizeMaintenanceDraft({
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
      });
      if (!f.ok) {
        return {
          ok: false,
          brain: "core_finalize_failed",
          draft: fastDraft,
          replyText: "Could not save ticket: " + (f.error || "error"),
          ...staffMeta(), ...outgateMeta("MAINTENANCE_ERROR_FINALIZE", {
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
            ticket_ids: finsFast.map((x) => x.ticketId),
            work_item_id: fin.workItemId,
            work_item_ids: finsFast.map((x) => x.workItemId),
            ticket_key: fin.ticketKey,
            ticket_keys: finsFast.map((x) => x.ticketKey),
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
            ticket_ids: finsFast.map((x) => x.ticketId),
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
        ...staffMeta(), ...outgateMeta("MAINTENANCE_ERROR_FINALIZE", { path: "fast" }),
      };
    }

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
        ...staffMeta(), ...outgateMeta("MAINTENANCE_RECEIPT_ONLY", {
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
      if (String(staffSchedHint).trim().length >= MIN_SCHEDULE_LEN) {
        let r = receiptFast;
        r = await appendPortalStaffScheduleNote(
          r,
          staffSchedHint,
          fin.ticketKey,
          traceId,
          traceStartMs,
          {
            afterLifecycle: true,
            propertyCodeHint: String(fastDraft.propertyCode || "").trim(),
            sb,
          }
        );
        await clearIntakeLike();
        await appendEventLog({
          traceId,
          event: "STAFF_CAPTURE_INLINE_SCHEDULE",
          payload: { ticket_key: fin.ticketKey, path: "fast" },
        });
        return {
          ok: true,
          brain: "core_finalized",
          draft: fastDraft,
          finalize: fin,
          path: "fast",
          replyText: r,
          ...staffMeta(), ...outgateMeta("MAINTENANCE_RECEIPT_ONLY", {
            path: "fast",
            staff_inline_schedule: true,
          }),
        };
      }
      await clearIntakeLike();
      await appendEventLog({
        traceId,
        event: "STAFF_CAPTURE_NO_SCHEDULE_PROMPT",
        payload: { ticket_key: fin.ticketKey, path: "fast" },
      });
      return {
        ok: true,
        brain: "core_finalized",
        draft: fastDraft,
        finalize: fin,
        path: "fast",
        replyText: receiptFast,
        ...staffMeta(), ...outgateMeta("MAINTENANCE_RECEIPT_ONLY", {
          path: "fast",
          staff_capture_no_schedule_ask: true,
        }),
      };
    }

    await setScheduleWaitLike({
      ticketKey: fin.ticketKey,
      draft_issue: fastDraft.issueText,
      draft_property: fastDraft.propertyCode,
      draft_unit: fastDraft.unitLabel,
    });
    await setPendingExpectedSchedule(canonicalBrainActorKey, fin.workItemId);
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
      ...staffMeta(), ...outgateMeta(maintenanceTemplateKeyForNext("SCHEDULE"), {
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
      ...staffMeta(), ...outgateMeta(maintenanceTemplateKeyForNext("ATTACH_CLARIFY")),
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
      draftSeqActive = allocSn.draftSeq;
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
      ...staffMeta(), ...outgateMeta(maintenanceTemplateKeyForNext(nextNew)),
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
    const finsMt = [];
    for (const g of groupsMt) {
      const f = await finalizeMaintenanceDraft({
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
      });
      if (!f.ok) {
        return {
          ok: false,
          brain: "core_finalize_failed",
          draft: merged,
          replyText: "Could not save ticket: " + (f.error || "error"),
          ...staffMeta(), ...outgateMeta("MAINTENANCE_ERROR_FINALIZE", { path: "multi_turn" }),
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
            ticket_ids: finsMt.map((x) => x.ticketId),
            work_item_id: fin.workItemId,
            work_item_ids: finsMt.map((x) => x.workItemId),
            ticket_key: fin.ticketKey,
            ticket_keys: finsMt.map((x) => x.ticketKey),
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
            ticket_ids: finsMt.map((x) => x.ticketId),
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
        ...staffMeta(), ...outgateMeta("MAINTENANCE_ERROR_FINALIZE", { path: "multi_turn" }),
      };
    }

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
        ...staffMeta(), ...outgateMeta("MAINTENANCE_RECEIPT_ONLY", {
          path: "multi_turn",
          emergency: em.emergency === "Yes",
          portalStaffCreate:
            mode === "MANAGER" && isPortalCreateTicketRouter(p) ? true : undefined,
        }),
      };
    }

    if (isStaffCapture) {
      const staffSchedHint = extractScheduleHintStaffCaptureFromTurn(merged, fastDraft, effectiveBody);
      if (String(staffSchedHint).trim().length >= MIN_SCHEDULE_LEN) {
        let r = receiptMt;
        r = await appendPortalStaffScheduleNote(
          r,
          staffSchedHint,
          fin.ticketKey,
          traceId,
          traceStartMs,
          {
            afterLifecycle: true,
            propertyCodeHint: String(merged.draft_property || "").trim(),
            sb,
          }
        );
        await clearIntakeLike();
        await appendEventLog({
          traceId,
          event: "STAFF_CAPTURE_INLINE_SCHEDULE",
          payload: { ticket_key: fin.ticketKey, path: "multi_turn" },
        });
        return {
          ok: true,
          brain: "core_finalized",
          draft: merged,
          finalize: fin,
          path: "multi_turn",
          replyText: r,
          ...staffMeta(), ...outgateMeta("MAINTENANCE_RECEIPT_ONLY", {
            path: "multi_turn",
            staff_inline_schedule: true,
          }),
        };
      }
      await clearIntakeLike();
      await appendEventLog({
        traceId,
        event: "STAFF_CAPTURE_NO_SCHEDULE_PROMPT",
        payload: { ticket_key: fin.ticketKey, path: "multi_turn" },
      });
      return {
        ok: true,
        brain: "core_finalized",
        draft: merged,
        finalize: fin,
        path: "multi_turn",
        replyText: receiptMt,
        ...staffMeta(), ...outgateMeta("MAINTENANCE_RECEIPT_ONLY", {
          path: "multi_turn",
          staff_capture_no_schedule_ask: true,
        }),
      };
    }

    await setScheduleWaitLike({
      ticketKey: fin.ticketKey,
      draft_issue: merged.draft_issue,
      issue_buf_json: merged.draft_issue_buf_json,
      draft_property: merged.draft_property,
      draft_unit: merged.draft_unit,
    });
    await setPendingExpectedSchedule(canonicalBrainActorKey, fin.workItemId);
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
      ...staffMeta(), ...outgateMeta(maintenanceTemplateKeyForNext("SCHEDULE"), {
        promptComposite: "after_receipt",
        path: "multi_turn",
      }),
    };
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
    ...staffMeta(), ...outgateMeta(maintenanceTemplateKeyForNext(next), {
      staff_photo_clarify: staffPhotoClarify || undefined,
    }),
  };
}

module.exports = { handleInboundCore };
