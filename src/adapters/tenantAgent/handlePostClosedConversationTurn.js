/**
 * Post-closed turns — thanks / all set after deflect without restarting gather loop.
 */
const { parseMediaJson } = require("../../brain/shared/mediaPayload");
const { isMaintenanceRepairRequest } = require("./classifyNonMaintenanceRequest");
const { appendMessage, saveTenantConversation } = require("./conversationStore");
const { isGatheringGreetingOnly, buildGatherGreetingReply } = require("./gatherGreetingReply");
const {
  isPostHandoffChitchat,
  isNoFurtherHelpNeeded,
  isConfusionOnly,
  postHandoffAckReply,
  postClosedSoftReply,
  postNoFurtherHelpReply,
} = require("./postHandoffReply");
const { conversationForNewIntake } = require("./postCompleteTurn");
const { mergePartialFromInboundMessage } = require("./mergePartialFromInbound");
const { intakeExplicitNewTicketMarkers } = require("../../brain/core/intakeAttachClassify");

const STATUS_CLOSED = "closed";

/**
 * @param {object | null | undefined} conv
 * @returns {boolean}
 */
function isConversationClosed(conv) {
  return String(conv && conv.status ? conv.status : "").trim() === STATUS_CLOSED;
}

/**
 * @param {object} o
 * @returns {Promise<{ handled: boolean, phase?: string, replyText?: string, conversationId?: string, tenantLocale?: string, continueGather?: boolean, conv?: object } | null>}
 */
async function handlePostClosedConversationTurn(o) {
  const conv = o.conv;
  if (!isConversationClosed(conv)) return null;

  const bodyText = String(o.bodyText || "").trim();
  const mediaItems = parseMediaJson(String((o.routerParameter && o.routerParameter._mediaJson) || ""));
  const turnCount = Number(conv.turn_count || 0) + 1;
  let messages = appendMessage(conv, "user", bodyText);

  if (mediaItems.length) {
    return reopenClosedForMaintenance(o, { turnCount, messages, bodyText });
  }

  if (bodyText && isPostHandoffChitchat(bodyText)) {
    const replyText = postHandoffAckReply(bodyText);
    await saveTenantConversation({
      ...conv,
      status: STATUS_CLOSED,
      turn_count: turnCount,
      messages: appendMessage({ messages }, "assistant", replyText),
    });
    return {
      handled: true,
      phase: "post_closed_ack",
      replyText,
      conversationId: conv.id,
      tenantLocale: conv.tenant_locale || "en",
    };
  }

  if (bodyText && isNoFurtherHelpNeeded(bodyText)) {
    const replyText = postNoFurtherHelpReply();
    await saveTenantConversation({
      ...conv,
      status: STATUS_CLOSED,
      turn_count: turnCount,
      messages: appendMessage({ messages }, "assistant", replyText),
    });
    return {
      handled: true,
      phase: "post_closed_done",
      replyText,
      conversationId: conv.id,
      tenantLocale: conv.tenant_locale || "en",
    };
  }

  if (bodyText && isConfusionOnly(bodyText)) {
    const replyText = postClosedSoftReply();
    await saveTenantConversation({
      ...conv,
      status: STATUS_CLOSED,
      turn_count: turnCount,
      messages: appendMessage({ messages }, "assistant", replyText),
    });
    return {
      handled: true,
      phase: "post_closed_soft",
      replyText,
      conversationId: conv.id,
      tenantLocale: conv.tenant_locale || "en",
    };
  }

  if (bodyText && isGatheringGreetingOnly(bodyText, {})) {
    const replyText = buildGatherGreetingReply({ propertiesList: o.propertiesList, partial: {} });
    await saveTenantConversation({
      ...conv,
      status: STATUS_CLOSED,
      turn_count: turnCount,
      messages: appendMessage({ messages }, "assistant", replyText),
    });
    return {
      handled: true,
      phase: "post_closed_greeting",
      replyText,
      conversationId: conv.id,
      tenantLocale: conv.tenant_locale || "en",
    };
  }

  if (
    bodyText &&
    (intakeExplicitNewTicketMarkers(bodyText) || isMaintenanceRepairRequest(bodyText))
  ) {
    return reopenClosedForMaintenance(o, { turnCount, messages, bodyText });
  }

  if (bodyText) {
    const replyText = postClosedSoftReply();
    await saveTenantConversation({
      ...conv,
      status: STATUS_CLOSED,
      turn_count: turnCount,
      messages: appendMessage({ messages }, "assistant", replyText),
    });
    return {
      handled: true,
      phase: "post_closed_soft",
      replyText,
      conversationId: conv.id,
      tenantLocale: conv.tenant_locale || "en",
    };
  }

  return null;
}

/**
 * @param {object} o
 * @param {object} ctx
 * @returns {Promise<{ handled: boolean, continueGather: boolean, conv: object, conversationId: string, tenantLocale: string }>}
 */
async function reopenClosedForMaintenance(o, ctx) {
  const conv = o.conv;
  const reset = conversationForNewIntake(conv);
  const partial = await mergePartialFromInboundMessage(
    {},
    ctx.bodyText,
    o.known,
    o.propertiesList,
    { traceId: o.traceId }
  );

  await saveTenantConversation({
    ...reset,
    status: "gathering",
    turn_count: 1,
    partial_package: partial,
    messages: appendMessage({ messages: ctx.messages }, "user", ctx.bodyText),
    tenant_locale: conv.tenant_locale || "en",
  });

  return {
    handled: false,
    continueGather: true,
    conversationId: conv.id,
    tenantLocale: conv.tenant_locale || "en",
    conv: {
      ...reset,
      status: "gathering",
      turn_count: 1,
      partial_package: partial,
      messages: appendMessage({ messages: ctx.messages }, "user", ctx.bodyText),
      tenant_locale: conv.tenant_locale || "en",
    },
  };
}

module.exports = {
  STATUS_CLOSED,
  isConversationClosed,
  handlePostClosedConversationTurn,
};
