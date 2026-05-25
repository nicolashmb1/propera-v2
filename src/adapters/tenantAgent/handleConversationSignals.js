/**
 * Conversation signals — closing / confused / done (adapter expression, not brain authority).
 */
const { appendMessage, saveTenantConversation } = require("./conversationStore");
const { isConversationComplete } = require("./conversationStatus");
const { isConversationClosed, STATUS_CLOSED } = require("./handlePostClosedConversationTurn");
const {
  isPostHandoffChitchat,
  isNoFurtherHelpNeeded,
  isConfusionOnly,
  isTenantConfusedMessage,
  postHandoffAckReply,
  postNoFurtherHelpReply,
  buildConfusionResetReply,
} = require("./postHandoffReply");
const { buildGatherGreetingReply, isGatheringGreetingOnly } = require("./gatherGreetingReply");

/**
 * @param {object} [partial]
 * @returns {boolean}
 */
function isEmptyGatherPartial(partial) {
  const p = partial || {};
  return (
    !String(p.property || "").trim() &&
    !String(p.unit || "").trim() &&
    String(p.issue || "").trim().length < 2
  );
}

/**
 * @param {object | null | undefined} conv
 * @returns {boolean}
 */
function tenantHasRecentTicket(conv) {
  if (!conv) return false;
  if (String(conv.active_ticket_key || "").trim()) return true;
  const last = conv.last_brain_result || {};
  const fin = last.finalize || {};
  return !!(fin.ticketKey || fin.ticketId || fin.ticket_id);
}

/**
 * @param {string} signal
 * @returns {'closing' | 'confused' | 'none'}
 */
function normalizeConversationSignal(signal) {
  const s = String(signal || "").trim().toLowerCase();
  if (s === "closing" || s === "close" || s === "done" || s === "ack") return "closing";
  if (s === "confused" || s === "confusion" || s === "reset") return "confused";
  return "none";
}

/**
 * Rule-based signal when LLM is off or did not return one.
 * @param {object} o
 * @returns {'closing' | 'confused' | 'none'}
 */
function detectConversationSignalRules(o) {
  const bodyText = String(o.bodyText || "").trim();
  if (!bodyText) return "none";

  if (isPostHandoffChitchat(bodyText) || isNoFurtherHelpNeeded(bodyText)) {
    return "closing";
  }
  if (isConfusionOnly(bodyText) || isTenantConfusedMessage(bodyText)) {
    return "confused";
  }

  return "none";
}

/**
 * @param {object} o
 * @returns {boolean}
 */
function shouldApplyConversationSignal(o) {
  const conv = o.conv;
  if (!conv) return false;

  const status = String(conv.status || "").trim();
  const partial = o.partial || conv.partial_package || {};
  const bodyText = String(o.bodyText || "").trim();

  if (isConversationClosed(conv) || isConversationComplete(conv)) return true;
  if (status === "gathering" && isEmptyGatherPartial(partial)) return true;
  if (
    status === "gathering" &&
    isTenantConfusedMessage(bodyText) &&
    !String(partial.property || "").trim()
  ) {
    return true;
  }
  if (status === "gathering" && isGatheringGreetingOnly(bodyText, partial)) return true;
  if (status === "same_or_new_pending" && tenantHasRecentTicket(conv)) return true;

  return false;
}

/**
 * @param {object} o
 * @returns {Promise<{ handled: boolean, phase?: string, replyText?: string, conversationId?: string, tenantLocale?: string } | null>}
 */
async function maybeHandleConversationSignal(o) {
  const conv = o.conv;
  if (!conv) return null;

  const bodyText = String(o.bodyText || "").trim();
  const llmSignal = normalizeConversationSignal(o.llmConversationSignal);
  const ruleSignal = detectConversationSignalRules({ bodyText, conv, partial: o.partial });
  const signal = llmSignal !== "none" ? llmSignal : ruleSignal;

  if (signal === "none") return null;
  if (!shouldApplyConversationSignal(o)) return null;

  const status = String(conv.status || "").trim();
  const turnCount = Number(conv.turn_count || 0) + 1;
  let messages = appendMessage(conv, "user", bodyText);

  let replyText = "";
  let phase = "";
  let nextStatus = status;

  if (signal === "closing") {
    replyText = isNoFurtherHelpNeeded(bodyText)
      ? postNoFurtherHelpReply()
      : postHandoffAckReply(bodyText);
    phase = "conversation_closing";
    nextStatus = isConversationComplete(conv) ? "complete" : STATUS_CLOSED;
  } else if (isGatheringGreetingOnly(bodyText, conv.partial_package || {})) {
    replyText = buildGatherGreetingReply({
      propertiesList: o.propertiesList,
      partial: {},
    });
    phase = "conversation_greeting";
  } else {
    replyText = buildConfusionResetReply();
    phase = "conversation_reset";
  }

  await saveTenantConversation({
    ...conv,
    status: nextStatus,
    turn_count: turnCount,
    partial_package: signal === "closing" ? conv.partial_package || {} : {},
    messages: appendMessage({ messages }, "assistant", replyText),
  });

  return {
    handled: true,
    phase,
    replyText,
    conversationId: conv.id,
    tenantLocale: conv.tenant_locale || "en",
  };
}

module.exports = {
  isEmptyGatherPartial,
  normalizeConversationSignal,
  detectConversationSignalRules,
  shouldApplyConversationSignal,
  maybeHandleConversationSignal,
};
