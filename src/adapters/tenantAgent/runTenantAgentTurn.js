/**
 * Tenant Agent turn — gather (deterministic or LLM) + structured handoff to brain.
 */
const { appendEventLog } = require("../../dal/appendEventLog");
const { listPropertiesForMenu } = require("../../dal/intakeSession");
const { getSupabase } = require("../../db/supabase");
const {
  lookupTenantRosterForAgent,
  applyRosterGatherContext,
} = require("./lookupTenantRosterForAgent");
const { loadPropertyCodesUpper } = require("../../brain/core/coreMaintenanceShared");
const { buildStructuredPortalCreateDraft } = require("../../brain/core/portalStructuredCreateDraft");
const {
  tenantAgentLlmEnabled,
  openaiApiKey,
  tenantAgentFallbackToLegacy,
} = require("../../config/env");
const { isPropertyOnTenantAgentPilot } = require("./propertyAllowlist");
const { completenessCheck } = require("./completeness");
const { promptForMissingField } = require("./deterministicPrompts");
const { buildHandoffRouterParameterFromAgent } = require("./buildHandoffRouterParameter");
const { buildAppendHandoffRouterParameter } = require("./buildAppendHandoffRouterParameter");
const { buildFindRelatedRouterParameter } = require("./buildFindRelatedRouterParameter");
const {
  loadTenantConversation,
  saveTenantConversation,
  appendMessage,
} = require("./conversationStore");
const {
  tenantConversationIsExpired,
  expireTenantConversationRow,
} = require("./conversationExpiry");
const { mergePartialFromInboundMessage } = require("./mergePartialFromInbound");
const { mergeScheduleSlotFromInbound } = require("./mergeScheduleSlotFromInbound");
const { mergePartialFromLlm } = require("./mergePartialFromLlm");
const { runTenantAgentLlmTurn } = require("./tenantAgentLlmTurn");
const { isConversationComplete } = require("./conversationStatus");
const {
  handlePostCompleteConversationTurn,
  STATUS_COMPLETE,
  STATUS_SAME_OR_NEW,
} = require("./postCompleteTurn");
const {
  isGatheringGreetingOnly,
  buildGatherGreetingReply,
} = require("./gatherGreetingReply");
const { parseMediaJson } = require("../../brain/shared/mediaPayload");
const { hasProblemSignal } = require("../../brain/core/splitIssueGroups");
const { parseRelatedTicketSelection } = require("./parseRelatedTicketSelection");
const { captureFollowUpPending } = require("./sameOrNewClarify");
const { buildStrongMatchClarifyPrompt } = require("./findRelatedPrompt");
const { intakeExplicitNewTicketMarkers } = require("../../brain/core/intakeAttachClassify");
const { maybeDeflectNonMaintenanceTurn } = require("./handleNonMaintenanceDeflect");
const { isNonMaintenanceRequest } = require("./classifyNonMaintenanceRequest");
const { isGenericMaintenanceIntakePhrase } = require("./gatherIssueSubstance");
const { resolveMaintenanceIntentForTurn } = require("./resolveMaintenanceIntentForTurn");
const { maybeHandleAccessTurn } = require("./maybeHandleAccessTurn");
const { dispatchByActiveLane } = require("./dispatchByActiveLane");
const { resolveActiveLane, CONVERSATION_LANE } = require("./conversationLane");
const {
  handlePostClosedConversationTurn,
  isConversationClosed,
} = require("./handlePostClosedConversationTurn");
const { maybeHandleConversationSignal } = require("./handleConversationSignals");
const { resolveGatherReply } = require("./resolveGatherReply");
const { applyGatherLocationFields } = require("./resolveGatherLocation");
const { postHandoffAckReply, shouldSkipInboundSlotMerge, isTenantConfusedMessage } = require("./postHandoffReply");
const {
  checkPreferredWindowForProperty,
  schedulePolicyRejectMessage,
  MIN_SCHEDULE_LEN,
} = require("../../dal/ticketPreferredWindow");
const { getAwaiting, setAwaiting, clearAwaiting } = require("./conversationAwaiting");
const { validateHandoffPayload, handoffRejectionPrompt } = require("./handoffContract");
const {
  recordMaintenanceContractRejection,
  recordMaintenanceTicketSuccess,
} = require("./conversationState");
const { mergeGatherSafety, getGatherSafety } = require("./detectGatherSafety");

/**
 * @param {object} conv
 * @param {string} bodyText
 * @returns {string[]}
 */
function gatherUserTextsForSafety(conv, bodyText) {
  const prev = (conv && conv.messages ? conv.messages : [])
    .filter((m) => m && m.role === "user")
    .map((m) => String(m.content || m.text || "").trim())
    .filter(Boolean);
  const cur = String(bodyText || "").trim();
  if (cur && prev[prev.length - 1] !== cur) prev.push(cur);
  return prev;
}
const {
  accumulatePartialPackageMedia,
  resolveHandoffMediaJson,
} = require("./accumulateConversationMedia");
const {
  isDuplicateGatherInbound,
  stampInboundTurnFingerprint,
} = require("./dedupeGatherInbound");

const ESCALATION_REPLY =
  "I want to make sure we get this right — a team member will follow up with you shortly.\n" +
  "If this is an emergency, please call 911.";

/**
 * @param {object} o
 * @returns {Promise<{ handled: boolean, phase?: string, replyText?: string, routerParameter?: object, conversationId?: string }>}
 */
async function tryTenantAgentHandoff(o) {
  const {
    conv,
    partial,
    known,
    propertiesList,
    tenantActorKey,
    transportChannel,
    traceId,
    routerParameter,
    turnCount,
    messages,
  } = o;

  const propertyCode = String(partial.property || "").trim().toUpperCase();
  if (propertyCode && !isPropertyOnTenantAgentPilot(propertyCode)) {
    return { handled: false };
  }

  const contractResult = validateHandoffPayload(partial, {
    knownPropertyCodesUpper: known,
  });
  if (!contractResult.valid) {
    const replyText = handoffRejectionPrompt(contractResult.rejectedFields[0]);
    let repairedPartial = { ...partial };
    for (const field of contractResult.rejectedFields) {
      delete repairedPartial[field];
    }
    // Stamp the rejection as a typed audit slot so the LLM (and any
    // observability tooling) can see *why* the brain refused this turn.
    repairedPartial = recordMaintenanceContractRejection(repairedPartial, {
      rejectedFields: contractResult.rejectedFields,
      rejectionReasons: contractResult.rejectionReasons,
      replyText,
    });
    await saveTenantConversation({
      ...conv,
      status: "gathering",
      turn_count: turnCount,
      partial_package: repairedPartial,
      messages: appendMessage({ messages }, "assistant", replyText),
    });
    return {
      handled: true,
      phase: "gather",
      replyText,
      conversationId: conv.id,
      tenantLocale: conv.tenant_locale || "en",
    };
  }

  const handoffRp = buildHandoffRouterParameterFromAgent({
    partialPackage: partial,
    tenantActorKey,
    transportChannel,
    conversationId: conv.id,
    traceId,
    mediaJson: resolveHandoffMediaJson(partial, String(routerParameter._mediaJson || "")),
    inboundRouterParameter: routerParameter,
  });

  const draftOk = buildStructuredPortalCreateDraft(handoffRp, known, propertiesList);
  if (!draftOk) {
    const incomplete = completenessCheck(partial, known);
    const replyText = promptForMissingField(
      incomplete.missing,
      partial,
      propertiesList
    );
    await saveTenantConversation({
      ...conv,
      status: "gathering",
      turn_count: turnCount,
      partial_package: partial,
      messages: appendMessage({ messages }, "assistant", replyText),
    });
    return {
      handled: true,
      phase: "gather",
      replyText,
      conversationId: conv.id,
      tenantLocale: conv.tenant_locale || "en",
    };
  }

  if (conv.handoff_trace_id === traceId && conv.status === "handoff_pending") {
    return {
      handled: true,
      phase: "handoff",
      routerParameter: handoffRp,
      conversationId: conv.id,
      tenantLocale: conv.tenant_locale || "en",
    };
  }

  const { withConversationLane } = require("./conversationLane");
  await saveTenantConversation({
    ...conv,
    status: "handoff_pending",
    turn_count: turnCount,
    partial_package: withConversationLane(partial, CONVERSATION_LANE.MAINTENANCE),
    messages,
    handoff_trace_id: traceId,
  });

  return {
    handled: true,
    phase: "handoff",
    routerParameter: handoffRp,
    conversationId: conv.id,
    tenantLocale: conv.tenant_locale || "en",
  };
}

/**
 * @param {object} o
 * @param {string} o.traceId
 * @param {'sms'|'whatsapp'|'telegram'} o.transportChannel
 * @param {Record<string, string>} o.routerParameter
 * @param {string} o.bodyText
 * @returns {Promise<{ handled: boolean, phase?: string, replyText?: string, routerParameter?: object, conversationId?: string }>}
 */
async function runTenantAgentTurn(o) {
  const traceId = String(o.traceId || "").trim();
  const transportChannel = String(o.transportChannel || "sms").toLowerCase();
  const routerParameter = o.routerParameter || {};
  const bodyText = String(o.bodyText || routerParameter.Body || "").trim();
  const tenantActorKey = String(
    routerParameter._canonicalBrainActorKey ||
      routerParameter._phoneE164 ||
      routerParameter.From ||
      ""
  ).trim();

  if (!tenantActorKey) {
    return { handled: false };
  }

  const propertiesList = await listPropertiesForMenu();
  const sb = getSupabase();
  const known = sb
    ? await loadPropertyCodesUpper(sb)
    : new Set(
        (propertiesList || [])
          .map((r) => String(r.code || "").trim().toUpperCase())
          .filter(Boolean)
      );

  let conv = await loadTenantConversation(tenantActorKey, transportChannel);
  let justExpired = false;

  if (conv && tenantConversationIsExpired(conv)) {
    await expireTenantConversationRow({ row: conv, traceId });
    conv = null;
    justExpired = true;
  }

  if (
    conv &&
    String(conv.status || "").trim() === "gathering" &&
    conv.partial_package &&
    Array.isArray(conv.partial_package._related_ticket_candidates) &&
    conv.partial_package._related_ticket_candidates.length
  ) {
    const picked = parseRelatedTicketSelection(
      bodyText,
      conv.partial_package._related_ticket_candidates
    );
    const turnCountPick = Number(conv.turn_count || 0) + 1;
    let messagesPick = appendMessage(conv, "user", bodyText);
    const mediaJsonPick = String(routerParameter._mediaJson || "");

    if (picked) {
      const partialPick = { ...(conv.partial_package || {}) };
      delete partialPick._related_ticket_candidates;
      const replyText = buildStrongMatchClarifyPrompt(picked);
      await saveTenantConversation({
        ...conv,
        status: STATUS_SAME_OR_NEW,
        turn_count: turnCountPick,
        active_ticket_key: String(picked.ticket_key || "").trim(),
        partial_package: {
          ...partialPick,
          _follow_up_pending: captureFollowUpPending({
            bodyText,
            mediaJson: mediaJsonPick,
          }),
        },
        messages: appendMessage({ messages: messagesPick }, "assistant", replyText),
        last_brain_result: {
          brain: "tenant_find_related_ticket",
          finalize: {
            ticketKey: picked.ticket_key,
            ticketId: picked.ticket_id,
          },
        },
      });
      return {
        handled: true,
        phase: "post_complete_clarify",
        replyText,
        conversationId: conv.id,
        tenantLocale: conv.tenant_locale || "en",
      };
    }

    if (intakeExplicitNewTicketMarkers(bodyText)) {
      const partialPick = { ...(conv.partial_package || {}) };
      delete partialPick._related_ticket_candidates;
      let partial = await mergePartialFromInboundMessage(
        {},
        bodyText,
        known,
        propertiesList,
        { traceId }
      );
      await saveTenantConversation({
        ...conv,
        status: "gathering",
        turn_count: turnCountPick,
        partial_package: partial,
        messages: messagesPick,
      });
      conv = {
        ...conv,
        status: "gathering",
        turn_count: turnCountPick,
        partial_package: partial,
        messages: messagesPick,
      };
    }
  }

  const _priorPartialForAwaiting = conv && conv.partial_package ? conv.partial_package : {};
  const _activeAwaiting = getAwaiting(_priorPartialForAwaiting);
  const _skipForScheduleAwaiting =
    _activeAwaiting && _activeAwaiting.type === "schedule_retry";

  // Sticky lane: one decision per session — if a lane is active, dispatch to it
  // and skip per-turn re-detection. The lane owns interpretation.
  if (!_skipForScheduleAwaiting) {
    const laneTurn = await dispatchByActiveLane({
      conv,
      bodyText,
      routerParameter,
      tenantActorKey,
      traceId,
      transportChannel,
    });
    if (laneTurn) {
      if (laneTurn.phase === "access_handoff" && laneTurn.routerParameter) {
        return laneTurn;
      }
      return laneTurn;
    }
  }

  // No active lane — try to detect access for the first time.
  const deflectTurn = _skipForScheduleAwaiting
    ? null
    : await maybeHandleAccessTurn({
        conv,
        bodyText,
        routerParameter,
        tenantActorKey,
        traceId,
        transportChannel,
      });
  if (deflectTurn && deflectTurn.phase === "access_handoff" && deflectTurn.routerParameter) {
    return deflectTurn;
  }
  if (deflectTurn) return deflectTurn;

  const nonMaintenanceTurn = _skipForScheduleAwaiting
    ? null
    : await maybeDeflectNonMaintenanceTurn({
        conv,
        bodyText,
        routerParameter,
        partial: conv && conv.partial_package ? conv.partial_package : {},
        tenantActorKey,
        traceId,
        transportChannel,
        propertiesList,
      });
  if (nonMaintenanceTurn) return nonMaintenanceTurn;

  const partialEarly = conv && conv.partial_package ? conv.partial_package : {};
  const signalEarly = _skipForScheduleAwaiting
    ? null
    : await maybeHandleConversationSignal({
        conv,
        bodyText,
        partial: partialEarly,
        propertiesList,
      });
  if (signalEarly) return signalEarly;

  if (conv && isConversationClosed(conv)) {
    const closedResult = await handlePostClosedConversationTurn({
      conv,
      bodyText,
      routerParameter,
      traceId,
      transportChannel,
      tenantActorKey,
      known,
      propertiesList,
    });
    if (closedResult && closedResult.handled) {
      return closedResult;
    }
    if (closedResult && closedResult.continueGather && closedResult.conv) {
      conv = closedResult.conv;
    }
  }

  if (
    conv &&
    (isConversationComplete(conv) ||
      String(conv.status || "").trim() === STATUS_SAME_OR_NEW)
  ) {
    const postResult = await handlePostCompleteConversationTurn({
      conv,
      bodyText,
      routerParameter,
      traceId,
      transportChannel,
      tenantActorKey,
      known,
      propertiesList,
    });
    if (postResult && postResult.handled) {
      return postResult;
    }
    if (postResult && postResult.continueGather && postResult.conv) {
      conv = postResult.conv;
    }
  }

  const deflectAfterPostComplete = await maybeDeflectNonMaintenanceTurn({
    conv,
    bodyText,
    routerParameter,
    partial: conv && conv.partial_package ? conv.partial_package : {},
    tenantActorKey,
    traceId,
    transportChannel,
    propertiesList,
  });
  if (deflectAfterPostComplete) return deflectAfterPostComplete;

  if (!conv) {
    const deflectNew = await maybeDeflectNonMaintenanceTurn({
      conv: null,
      bodyText,
      routerParameter,
      partial: {},
      tenantActorKey,
      traceId,
      transportChannel,
      propertiesList,
    });
    if (deflectNew) return deflectNew;

    const mediaItems = parseMediaJson(String(routerParameter._mediaJson || ""));
    const intentSeed = await resolveMaintenanceIntentForTurn({
      bodyText,
      conv: null,
      partial: {},
      traceId,
    });
    const greetingOnlySeed =
      intentSeed.intent === "unclear" || isGatheringGreetingOnly(bodyText, {});
    const partialSeed = greetingOnlySeed
      ? {}
      : mergeScheduleSlotFromInbound(
          await mergePartialFromInboundMessage(
            {},
            bodyText,
            known,
            propertiesList,
            { traceId }
          ),
          bodyText
        );

    const shouldFindRelated =
      justExpired &&
      !greetingOnlySeed &&
      !isNonMaintenanceRequest(bodyText) &&
      (hasProblemSignal(bodyText) || mediaItems.length > 0);

    if (shouldFindRelated) {
      conv = await saveTenantConversation({
        tenant_actor_key: tenantActorKey,
        transport_channel: transportChannel,
        status: "gathering",
        partial_package: partialSeed,
        messages: appendMessage({ messages: [] }, "user", bodyText),
        turn_count: 1,
      });
      if (conv) {
        return {
          handled: true,
          phase: "find_related_handoff",
          routerParameter: buildFindRelatedRouterParameter({
            tenantActorKey,
            partialPackage: partialSeed,
            bodyText,
            transportChannel,
            conversationId: conv.id,
            traceId,
          }),
          conversationId: conv.id,
          tenantLocale: conv.tenant_locale || "en",
        };
      }
    }

    conv = await saveTenantConversation({
      tenant_actor_key: tenantActorKey,
      transport_channel: transportChannel,
      status: "gathering",
      partial_package: {},
      messages: [],
      turn_count: 0,
    });
  }

  if (!conv) {
    return { handled: false };
  }

  if (
    isDuplicateGatherInbound(
      conv,
      bodyText,
      String(routerParameter._mediaJson || "")
    )
  ) {
    await appendEventLog({
      traceId,
      event: "TENANT_AGENT_DUPLICATE_INBOUND",
      payload: {
        tenant_actor_key: tenantActorKey,
        conversation_id: conv.id,
      },
    });
    return {
      handled: true,
      phase: "duplicate_inbound",
      conversationId: conv.id,
      tenantLocale: conv.tenant_locale || "en",
    };
  }

  const turnCount = Number(conv.turn_count || 0) + 1;
  const maxTurns = Number(conv.max_turns || 12);

  const priorPartial = conv.partial_package || {};
  const gatherIntent = await resolveMaintenanceIntentForTurn({
    bodyText,
    conv,
    partial: priorPartial,
    traceId,
  });
  const greetingOnly =
    gatherIntent.intent === "unclear" || isGatheringGreetingOnly(bodyText, priorPartial);
  const skipSlotMerge =
    greetingOnly || shouldSkipInboundSlotMerge(bodyText) || isTenantConfusedMessage(bodyText);

  let partial = skipSlotMerge
    ? { ...priorPartial }
    : mergeScheduleSlotFromInbound(
        await mergePartialFromInboundMessage(
          priorPartial,
          bodyText,
          known,
          propertiesList,
          { traceId }
        ),
        bodyText
      );

  partial = accumulatePartialPackageMedia(
    partial,
    String(routerParameter._mediaJson || "")
  );
  partial = stampInboundTurnFingerprint(
    partial,
    bodyText,
    String(routerParameter._mediaJson || "")
  );

  if (!partial._roster_lookup_done) {
    const sbRoster = getSupabase();
    const rosterLookup = await lookupTenantRosterForAgent({
      sb: sbRoster,
      routerParameter,
      tenantActorKey,
      knownPropertyCodesUpper: known,
    });
    partial = applyRosterGatherContext(partial, rosterLookup);
  }

  let messages = appendMessage(conv, "user", bodyText);
  /** @type {string | null} */
  let llmGatherReply = null;
  /** @type {string} */
  let llmRequestIntent = "";
  /** @type {string} */
  let llmConversationSignal = "";
  let tenantLocaleUpdate = conv.tenant_locale || "en";

  if (greetingOnly && !completenessCheck(partial, known).ready) {
    const replyText = buildGatherGreetingReply({ propertiesList, partial });
    await saveTenantConversation({
      ...conv,
      status: "gathering",
      turn_count: turnCount,
      partial_package: partial,
      tenant_locale: tenantLocaleUpdate,
      messages: appendMessage({ messages }, "assistant", replyText),
    });
    return {
      handled: true,
      phase: "gather",
      replyText,
      conversationId: conv.id,
      tenantLocale: tenantLocaleUpdate,
    };
  }

  const llmActive =
    tenantAgentLlmEnabled() && !!openaiApiKey();
  const userTextsForSafety = gatherUserTextsForSafety(conv, bodyText);
  /** @type {object | undefined} */
  let llmSafetyAssessment;

  if (llmActive) {
    const llm = await runTenantAgentLlmTurn({
      inboundMessage: bodyText,
      partialPackage: partial,
      messages: conv.messages || [],
      propertiesList,
      traceId,
    });

    if (llm.ok) {
      partial = mergePartialFromLlm(partial, llm.partialUpdates, known);
      partial = mergeScheduleSlotFromInbound(partial, bodyText);
      llmGatherReply = String(llm.reply || "").trim() || null;
      llmRequestIntent = String(llm.requestIntent || "").trim();
      llmConversationSignal = String(llm.conversationSignal || "").trim();
      llmSafetyAssessment = llm.safetyAssessment;
      if (llm.tenantLocale) tenantLocaleUpdate = llm.tenantLocale;
      if (partial._llm_fail_streak) delete partial._llm_fail_streak;

      applyGatherLocationFields(partial, {
        body: bodyText,
        prev: priorPartial,
        parsed: {},
      });

      const signalFromLlm = _skipForScheduleAwaiting
        ? null
        : await maybeHandleConversationSignal({
            conv: { ...conv, tenant_locale: tenantLocaleUpdate },
            bodyText,
            partial,
            propertiesList,
            llmConversationSignal,
          });
      if (signalFromLlm) return signalFromLlm;

      if (llmRequestIntent === "non_maintenance") {
        const deflectFromGather = await maybeDeflectNonMaintenanceTurn({
          conv,
          bodyText,
          routerParameter,
          partial,
          tenantActorKey,
          traceId,
          transportChannel,
          propertiesList,
          forceIntent: "non_maintenance",
        });
        if (deflectFromGather) return deflectFromGather;
      }
    } else {
      partial._llm_fail_streak = Number(partial._llm_fail_streak || 0) + 1;
      await appendEventLog({
        traceId,
        event: "TENANT_AGENT_LLM_FAILED",
        payload: {
          err: String(llm.err || "unknown"),
          tenant_actor_key: tenantActorKey,
          conversation_id: conv.id,
          fail_streak: partial._llm_fail_streak,
        },
      });

      if (tenantAgentFallbackToLegacy() && partial._llm_fail_streak >= 2) {
        const sbDel = getSupabase();
        if (sbDel) {
          await sbDel
            .from("tenant_conversations")
            .delete()
            .eq("id", conv.id);
        }
        return { handled: false };
      }
    }
  }

  partial = mergeGatherSafety(
    partial,
    bodyText,
    llmSafetyAssessment,
    userTextsForSafety
  );

  if (turnCount > maxTurns) {
    await saveTenantConversation({
      ...conv,
      status: "escalated",
      turn_count: turnCount,
      partial_package: partial,
      tenant_locale: tenantLocaleUpdate,
      messages: appendMessage({ messages }, "assistant", ESCALATION_REPLY),
    });
    await appendEventLog({
      traceId,
      event: "TENANT_AGENT_ESCALATED",
      payload: {
        tenant_actor_key: tenantActorKey,
        conversation_id: conv.id,
        turn_count: turnCount,
      },
    });
    return {
      handled: true,
      phase: "escalated",
      replyText: ESCALATION_REPLY,
      conversationId: conv.id,
      tenantLocale: tenantLocaleUpdate,
    };
  }

  const propertyCode = String(partial.property || "").trim().toUpperCase();
  if (propertyCode && !isPropertyOnTenantAgentPilot(propertyCode)) {
    const replyText =
      "This property isn't on the maintenance agent pilot yet — reply with your issue and we'll route it the usual way.";
    await saveTenantConversation({
      ...conv,
      turn_count: turnCount,
      partial_package: partial,
      tenant_locale: tenantLocaleUpdate,
      messages: appendMessage({ messages }, "assistant", replyText),
      status: "closed",
    });
    return { handled: false };
  }

  if (partial.issue && isGenericMaintenanceIntakePhrase(partial.issue)) {
    delete partial.issue;
  }

  const complete = completenessCheck(partial, known);

  if (complete.ready) {
    const commonArea =
      String(partial.location_kind || "").trim().toLowerCase() === "common_area";
    const safety = getGatherSafety(partial);
    const schedRaw = String(partial.preferredWindow || "").trim();
    if (!commonArea && !safety?.skipScheduling && schedRaw.length >= MIN_SCHEDULE_LEN) {
      const schedCheck = await checkPreferredWindowForProperty(
        String(partial.property || "").trim().toUpperCase(),
        schedRaw,
        { traceId }
      );
      if (!schedCheck.ok && schedCheck.policyKey) {
        const replyText = schedulePolicyRejectMessage(
          schedCheck.policyKey,
          schedCheck.policyVars
        );
        partial._schedule_retry_pending = true;
        delete partial.preferredWindow;
        partial = setAwaiting(partial, "schedule_retry", {
          policyKey: schedCheck.policyKey,
        });
        await saveTenantConversation({
          ...conv,
          status: "gathering",
          turn_count: turnCount,
          partial_package: partial,
          tenant_locale: tenantLocaleUpdate,
          messages: appendMessage({ messages }, "assistant", replyText),
        });
        return {
          handled: true,
          phase: "gather",
          replyText,
          conversationId: conv.id,
          tenantLocale: tenantLocaleUpdate,
        };
      }
      if (schedCheck.ok && schedCheck.label) {
        partial.preferredWindow = String(schedCheck.label).trim();
        partial = clearAwaiting(partial);
        delete partial._schedule_retry_pending;
      }
    }
    return tryTenantAgentHandoff({
      conv: { ...conv, tenant_locale: tenantLocaleUpdate },
      partial,
      known,
      propertiesList,
      tenantActorKey,
      transportChannel,
      traceId,
      routerParameter,
      turnCount,
      messages,
    });
  }

  if (isConversationClosed(conv)) {
    const signalLate = await maybeHandleConversationSignal({
      conv,
      bodyText,
      partial,
      propertiesList,
      llmConversationSignal,
    });
    if (signalLate) return signalLate;

    const closedLate = await handlePostClosedConversationTurn({
      conv,
      bodyText,
      routerParameter,
      traceId,
      transportChannel,
      tenantActorKey,
      known,
      propertiesList,
    });
    if (closedLate && closedLate.handled) return closedLate;
    if (closedLate && closedLate.continueGather && closedLate.conv) {
      conv = closedLate.conv;
    } else if (!closedLate || !closedLate.handled) {
      return {
        handled: true,
        phase: "post_closed_soft",
        replyText: postHandoffAckReply(bodyText),
        conversationId: conv.id,
        tenantLocale: tenantLocaleUpdate,
      };
    }
  }

  const replyText = resolveGatherReply({
    llmGatherReply,
    complete,
    partial,
    propertiesList,
    recentMessages: messages,
    bodyText,
  });

  if (getGatherSafety(partial) && !partial._safety_ack_sent) {
    partial._safety_ack_sent = true;
  }

  const deflectBeforeReply = await maybeDeflectNonMaintenanceTurn({
    conv,
    bodyText,
    routerParameter,
    partial,
    tenantActorKey,
    traceId,
    transportChannel,
    propertiesList,
  });
  if (deflectBeforeReply) return deflectBeforeReply;

  await saveTenantConversation({
    ...conv,
    status: "gathering",
    turn_count: turnCount,
    partial_package: partial,
    tenant_locale: tenantLocaleUpdate,
    messages: appendMessage({ messages }, "assistant", replyText),
  });

  return {
    handled: true,
    phase: "gather",
    replyText,
    conversationId: conv.id,
    tenantLocale: tenantLocaleUpdate,
  };
}

/**
 * Record brain result after successful handoff finalize.
 * @param {object} o
 * @param {string} o.conversationId
 * @param {string} o.traceId
 * @param {object | null} o.coreRun
 */
async function recordTenantAgentHandoffResult(o) {
  const conversationId = String(o.conversationId || "").trim();
  if (!conversationId) return;

  const sb = require("../../db/supabase").getSupabase();
  if (!sb) return;

  const { data: row } = await sb
    .from("tenant_conversations")
    .select("*")
    .eq("id", conversationId)
    .maybeSingle();

  if (!row) return;

  const coreRun = o.coreRun || {};
  const fin = coreRun.finalize || {};
  const ticketKey =
    fin.ticketKey ||
    (Array.isArray(fin.tickets) && fin.tickets[0] && fin.tickets[0].ticket_key) ||
    "";

  const nextStatus =
    coreRun.brain === "core_finalized"
      ? STATUS_COMPLETE
      : coreRun.brain === "tenant_append_to_ticket"
        ? STATUS_COMPLETE
        : "gathering";

  // Mirror the access lane's last-booking slot: on a successful handoff,
  // stamp a typed snapshot of the just-created ticket into partial_package
  // so follow-up turns ("what happened with the leak from yesterday?") have
  // a deterministic anchor instead of fishing through last_brain_result.
  const succeeded =
    coreRun.brain === "core_finalized" || coreRun.brain === "tenant_append_to_ticket";
  const partialBefore =
    row.partial_package && typeof row.partial_package === "object" ? row.partial_package : {};
  const nextPartial = succeeded
    ? recordMaintenanceTicketSuccess(partialBefore, {
        ticketKey: String(ticketKey || "").trim(),
        propertyCode: String(partialBefore.property || partialBefore.property_code || "").trim().toUpperCase(),
        unitLabel: String(partialBefore.unit || partialBefore.unit_label || "").trim(),
        locationKind: String(partialBefore.location_kind || "").trim().toLowerCase(),
        category: String(partialBefore.category || fin.category || "").trim(),
        issueSummary: String(partialBefore.issue || partialBefore.message || "").trim(),
        preferredWindow: String(partialBefore.preferredWindow || "").trim(),
        emergency: String(partialBefore.emergency || "").toLowerCase() === "yes",
      })
    : partialBefore;

  await saveTenantConversation({
    ...row,
    status: nextStatus,
    handoff_at: new Date().toISOString(),
    handoff_trace_id: String(o.traceId || row.handoff_trace_id || "").trim(),
    active_ticket_key: String(ticketKey || "").trim(),
    partial_package: nextPartial,
    last_brain_result: {
      brain: coreRun.brain,
      replyText: coreRun.replyText,
      finalize: fin,
      outgate: coreRun.outgate || null,
    },
  });

  if (nextStatus === STATUS_COMPLETE) {
    try {
      const { clearIntakeSessionDraft } = require("../../dal/intakeSession");
      const actorKey = String(row.tenant_actor_key || "").trim();
      if (actorKey) {
        await clearIntakeSessionDraft(actorKey);
      }
    } catch (_) {
      // Non-fatal — pipeline catch-all blocks core when tenantAgentRun is set.
    }
  }
}

module.exports = {
  runTenantAgentTurn,
  recordTenantAgentHandoffResult,
};
