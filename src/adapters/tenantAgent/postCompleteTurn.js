/**
 * Post-complete conversation turns — clarify before append or new intake (Phase 4).
 */
const { parseMediaJson } = require("../../brain/shared/mediaPayload");
const { appendMessage, saveTenantConversation } = require("./conversationStore");
const { setAwaiting, clearAwaiting } = require("./conversationAwaiting");
const { isPostHandoffChitchat, postHandoffAckReply } = require("./postHandoffReply");
const { resolvePostCompleteFollowUpIntent } = require("./resolvePostCompleteFollowUpIntent");
const { isScheduleFollowUpContent } = require("./scheduleFollowUpShape");
const {
  buildSameOrNewPrompt,
  buildSameOrNewReaskPrompt,
  resolveSameOrNewReply,
  captureFollowUpPending,
} = require("./sameOrNewClarify");
const { buildAppendHandoffRouterParameter } = require("./buildAppendHandoffRouterParameter");
const { mergePartialFromInboundMessage } = require("./mergePartialFromInbound");
const { resolveAppendHandoffContent } = require("./resolveAppendHandoffContent");
const { isScheduleOnlyReply } = require("./mergeScheduleSlotFromInbound");
const {
  applyPreferredWindowByTicketKey,
  schedulePolicyRejectMessage,
  MIN_SCHEDULE_LEN,
} = require("../../dal/ticketPreferredWindow");
const { telegramStaffCaptureActor } = require("../../dal/ticketAuditPatch");
const { isNonMaintenanceRequest } = require("./classifyNonMaintenanceRequest");
const { maybeDeflectNonMaintenanceTurn } = require("./handleNonMaintenanceDeflect");

const STATUS_COMPLETE = "complete";
const STATUS_SAME_OR_NEW = "same_or_new_pending";

/**
 * @param {object[]} [messages]
 * @returns {boolean}
 */
function lastAssistantAskedScheduleRetry(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant") {
      const text = String(m.content || m.text || "");
      return (
        /different day that matches|outside allowed hours|too soon|too far|service window|maintenance visit instead/i.test(
          text
        ) ||
        /regular maintenance hours are|maintenance hours are|what day and time works|what time works for you|within those hours|please try another day|choose another time|advance notice/i.test(
          text
        )
      );
    }
    if (m && m.role === "user") break;
  }
  return false;
}

/**
 * Reset for a confirmed new intake — keep tenant locale / ticket ref for prompts only.
 * @param {object} conv
 * @returns {object}
 */
function conversationForNewIntake(conv) {
  return {
    ...conv,
    status: "gathering",
    partial_package: {},
    messages: [],
    turn_count: 0,
    handoff_trace_id: null,
    handoff_at: null,
    last_brain_result: conv.last_brain_result,
    active_ticket_key: conv.active_ticket_key,
  };
}

/**
 * @param {object} o
 * @returns {Promise<{ handled: boolean, phase?: string, replyText?: string, conversationId?: string, tenantLocale?: string } | null>}
 */
async function applyScheduleUpdateForOpenTicket(o) {
  const { conv, schedText, messages, turnCount, traceId } = o;
  const ticketKey = String(conv.active_ticket_key || "").trim();
  const windowText = String(schedText || "").trim();
  if (!ticketKey || windowText.length < MIN_SCHEDULE_LEN) return null;

  const applied = await applyPreferredWindowByTicketKey({
    ticketKey,
    preferredWindow: windowText,
    traceId,
    recentMessages: o.recentMessages || messages,
    ticketChangedBy: telegramStaffCaptureActor(),
  });
  const partialPkg = clearAwaiting({ ...(conv.partial_package || {}) });
  delete partialPkg._schedule_retry_pending;
  delete partialPkg._follow_up_pending;

  if (applied.ok) {
    const label = (applied.parsed && applied.parsed.label) || windowText;
    const replyText = `Got it — preferred visit window noted: ${label}.`;
    await saveTenantConversation({
      ...conv,
      status: STATUS_COMPLETE,
      turn_count: turnCount,
      partial_package: partialPkg,
      messages: appendMessage({ messages }, "assistant", replyText),
    });
    return {
      handled: true,
      phase: "post_handoff",
      replyText,
      conversationId: conv.id,
      tenantLocale: conv.tenant_locale || "en",
    };
  }
  if (applied.policyKey) {
    const replyText = schedulePolicyRejectMessage(applied.policyKey, applied.policyVars);
    partialPkg._schedule_retry_pending = true;
    const partialWithAwaiting = setAwaiting(partialPkg, "schedule_retry", {
      policyKey: applied.policyKey,
    });
    await saveTenantConversation({
      ...conv,
      status: STATUS_COMPLETE,
      turn_count: turnCount,
      partial_package: partialWithAwaiting,
      messages: appendMessage({ messages }, "assistant", replyText),
    });
    return {
      handled: true,
      phase: "post_handoff",
      replyText,
      conversationId: conv.id,
      tenantLocale: conv.tenant_locale || "en",
    };
  }
  return null;
}

/**
 * @param {object} o
 * @returns {Promise<{ handled: boolean, phase?: string, replyText?: string, routerParameter?: object, conversationId?: string, tenantLocale?: string } | null>}
 */
async function handlePostCompleteConversationTurn(o) {
  const {
    conv,
    bodyText,
    routerParameter,
    traceId,
    transportChannel,
    tenantActorKey,
    known,
    propertiesList,
  } = o;

  const turnCount = Number(conv.turn_count || 0) + 1;
  let messages = appendMessage(conv, "user", bodyText);
  const mediaJson = String(routerParameter._mediaJson || "");
  const mediaItems = parseMediaJson(mediaJson);
  const activeTicketKey = String(conv.active_ticket_key || "").trim();

  if (activeTicketKey) {
    const awaitingScheduleRetry =
      !!(conv.partial_package && conv.partial_package._schedule_retry_pending) ||
      lastAssistantAskedScheduleRetry(conv.messages);
    const schedText = String(bodyText || "").trim();

    if (
      awaitingScheduleRetry &&
      schedText.length >= MIN_SCHEDULE_LEN &&
      (isScheduleOnlyReply(schedText) || awaitingScheduleRetry)
    ) {
      const scheduleOut = await applyScheduleUpdateForOpenTicket({
        conv,
        schedText,
        messages,
        turnCount,
        traceId,
        recentMessages: messages,
      });
      if (scheduleOut) return scheduleOut;
    }

    const followUp = await resolvePostCompleteFollowUpIntent({
      bodyText,
      activeTicketKey,
      lastBrainResult: conv.last_brain_result,
      recentMessages: messages,
      mediaItems,
      traceId,
    });

    if (followUp.intent === "schedule_update") {
      const windowText = String(followUp.preferredWindow || bodyText).trim();
      const scheduleOut = await applyScheduleUpdateForOpenTicket({
        conv,
        schedText: windowText,
        messages,
        turnCount,
        traceId,
      });
      if (scheduleOut) return scheduleOut;
    }

    if (followUp.intent === "ack_only" && isPostHandoffChitchat(bodyText)) {
      const replyText = postHandoffAckReply(bodyText);
      await saveTenantConversation({
        ...conv,
        status: STATUS_COMPLETE,
        turn_count: turnCount,
        messages: appendMessage({ messages }, "assistant", replyText),
      });
      return {
        handled: true,
        phase: "post_handoff",
        replyText,
        conversationId: conv.id,
        tenantLocale: conv.tenant_locale || "en",
      };
    }

    if (followUp.intent === "new_intake") {
      const reset = conversationForNewIntake(conv);
      let partial = await mergePartialFromInboundMessage(
        {},
        bodyText,
        known,
        propertiesList,
        { traceId }
      );
      await saveTenantConversation({
        ...reset,
        turn_count: 1,
        partial_package: partial,
        messages,
        tenant_locale: conv.tenant_locale || "en",
      });
      return {
        handled: false,
        continueGather: true,
        conversationId: conv.id,
        conv: {
          ...reset,
          turn_count: 1,
          partial_package: partial,
          messages,
          tenant_locale: conv.tenant_locale || "en",
        },
      };
    }
  }

  if (conv.status === STATUS_SAME_OR_NEW) {
    const resolved = await resolveSameOrNewReply({
      bodyText,
      traceId,
      recentMessages: conv.messages || [],
      pendingFollowUp: conv.partial_package && conv.partial_package._follow_up_pending,
    });
    const choice = resolved.choice;
    const pending = (conv.partial_package && conv.partial_package._follow_up_pending) || {};

    if (choice === "same") {
      const ticketKey = String(conv.active_ticket_key || "").trim();
      const pendingBody = String(pending.bodyText || "").trim();
      const scheduleNote = String(resolved.appendNote || "").trim();
      const scheduleText =
        (scheduleNote && isScheduleFollowUpContent(scheduleNote) && scheduleNote) ||
        (pendingBody && isScheduleFollowUpContent(pendingBody) && pendingBody) ||
        (isScheduleFollowUpContent(bodyText) && bodyText) ||
        "";

      if (ticketKey && scheduleText) {
        const scheduleOut = await applyScheduleUpdateForOpenTicket({
          conv,
          schedText: scheduleText,
          messages,
          turnCount,
          traceId,
        });
        if (scheduleOut) return scheduleOut;
      }

      if (!ticketKey) {
        const replyText = buildSameOrNewPrompt(conv);
        await saveTenantConversation({
          ...conv,
          status: STATUS_SAME_OR_NEW,
          turn_count: turnCount,
          messages: appendMessage({ messages }, "assistant", replyText),
        });
        return {
          handled: true,
          phase: "post_complete_clarify",
          replyText,
          conversationId: conv.id,
          tenantLocale: conv.tenant_locale || "en",
        };
      }

      const appendContent = resolveAppendHandoffContent({
        pending,
        confirmBodyText: bodyText,
        confirmMediaJson: mediaJson,
        llmAppendNote: resolved.appendNote,
      });

      const appendRp = buildAppendHandoffRouterParameter({
        ticketKey,
        tenantActorKey,
        message: appendContent.message,
        mediaJson: appendContent.mediaJson,
        transportChannel,
        conversationId: conv.id,
        traceId,
      });

      const partial = { ...(conv.partial_package || {}) };
      delete partial._follow_up_pending;

      await saveTenantConversation({
        ...conv,
        status: STATUS_COMPLETE,
        turn_count: turnCount,
        partial_package: partial,
        messages,
        handoff_trace_id: traceId,
      });

      return {
        handled: true,
        phase: "append_handoff",
        routerParameter: appendRp,
        conversationId: conv.id,
        tenantLocale: conv.tenant_locale || "en",
      };
    }

    if (choice === "new") {
      const seedBody =
        String(pending.bodyText || "").trim() || String(bodyText || "").trim();

      if (activeTicketKey && seedBody && isScheduleFollowUpContent(seedBody)) {
        const scheduleOut = await applyScheduleUpdateForOpenTicket({
          conv,
          schedText: seedBody,
          messages,
          turnCount,
          traceId,
        });
        if (scheduleOut) return scheduleOut;
      }

      if (seedBody && isNonMaintenanceRequest(seedBody)) {
        const deflect = await maybeDeflectNonMaintenanceTurn({
          conv,
          bodyText: seedBody,
          routerParameter,
          partial: {},
          tenantActorKey,
          traceId,
          transportChannel,
          propertiesList,
        });
        if (deflect) return deflect;
      }

      const reset = conversationForNewIntake(conv);
      let partial = await mergePartialFromInboundMessage(
        {},
        seedBody,
        known,
        propertiesList,
        { traceId }
      );
      partial = { ...partial, _follow_up_pending: undefined };
      messages = appendMessage({ messages: [] }, "user", seedBody || bodyText);

      await saveTenantConversation({
        ...reset,
        turn_count: 1,
        partial_package: partial,
        messages,
        tenant_locale: conv.tenant_locale || "en",
      });

      return {
        handled: false,
        continueGather: true,
        conversationId: conv.id,
        conv: {
          ...reset,
          turn_count: 1,
          partial_package: partial,
          messages,
          tenant_locale: conv.tenant_locale || "en",
        },
      };
    }

    const replyText = buildSameOrNewReaskPrompt();
    await saveTenantConversation({
      ...conv,
      status: STATUS_SAME_OR_NEW,
      turn_count: turnCount,
      messages: appendMessage({ messages }, "assistant", replyText),
    });
    return {
      handled: true,
      phase: "post_complete_clarify",
      replyText,
      conversationId: conv.id,
      tenantLocale: conv.tenant_locale || "en",
    };
  }

  if (isPostHandoffChitchat(bodyText)) {
    const replyText = postHandoffAckReply(bodyText);
    await saveTenantConversation({
      ...conv,
      status: STATUS_COMPLETE,
      turn_count: turnCount,
      messages: appendMessage({ messages }, "assistant", replyText),
    });
    return {
      handled: true,
      phase: "post_handoff",
      replyText,
      conversationId: conv.id,
      tenantLocale: conv.tenant_locale || "en",
    };
  }

  const replyText = buildSameOrNewPrompt(conv);
  const partial = {
    ...(conv.partial_package || {}),
    _follow_up_pending: captureFollowUpPending({ bodyText, mediaJson }),
  };

  await saveTenantConversation({
    ...conv,
    status: STATUS_SAME_OR_NEW,
    turn_count: turnCount,
    partial_package: partial,
    messages: appendMessage({ messages }, "assistant", replyText),
  });

  return {
    handled: true,
    phase: "post_complete_clarify",
    replyText,
    conversationId: conv.id,
    tenantLocale: conv.tenant_locale || "en",
  };
}

module.exports = {
  handlePostCompleteConversationTurn,
  applyScheduleUpdateForOpenTicket,
  conversationForNewIntake,
  STATUS_COMPLETE,
  STATUS_SAME_OR_NEW,
};
