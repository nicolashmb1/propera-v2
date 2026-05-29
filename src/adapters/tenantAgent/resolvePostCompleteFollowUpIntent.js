/**
 * Post-handoff follow-up routing — LLM interpretation with structural schedule guardrails.
 */
const { classifyPostCompleteFollowUp } = require("./classifyPostCompleteFollowUp");
const { classifyPostCompleteFollowUpWithLlm } = require("./classifyPostCompleteFollowUpWithLlm");
const { isScheduleFollowUpContent } = require("./scheduleFollowUpShape");
const { tenantAgentLlmEnabled, openaiApiKey } = require("../../config/env");

/**
 * @typedef {'schedule_update' | 'ack_only' | 'append_to_ticket' | 'new_intake' | 'ask_same_or_new'} PostCompleteResolvedIntent
 */

/**
 * @param {object} o
 * @param {string} o.bodyText
 * @param {string} [o.activeTicketKey]
 * @param {object} [o.lastBrainResult]
 * @param {object[]} [o.recentMessages]
 * @param {unknown[]} [o.mediaItems]
 * @param {string} [o.traceId]
 * @returns {Promise<{ intent: PostCompleteResolvedIntent, preferredWindow: string, source: string }>}
 */
async function resolvePostCompleteFollowUpIntent(o) {
  const bodyText = String(o.bodyText || "").trim();
  const activeTicketKey = String(o.activeTicketKey || "").trim();
  const mediaItems = Array.isArray(o.mediaItems) ? o.mediaItems : [];

  if (activeTicketKey && bodyText && isScheduleFollowUpContent(bodyText)) {
    return {
      intent: "schedule_update",
      preferredWindow: bodyText,
      source: "schedule_shape",
    };
  }

  if (activeTicketKey && tenantAgentLlmEnabled() && openaiApiKey() && bodyText) {
    const llm = await classifyPostCompleteFollowUpWithLlm({
      bodyText,
      activeTicketKey,
      lastBrainResult: o.lastBrainResult,
      recentMessages: o.recentMessages,
      traceId: o.traceId,
    });
    if (llm.intent === "schedule_update") {
      return {
        intent: "schedule_update",
        preferredWindow: String(llm.preferredWindow || bodyText).trim(),
        source: llm.source || "llm",
      };
    }
    if (llm.intent === "ack_only") {
      return { intent: "ack_only", preferredWindow: "", source: llm.source || "llm" };
    }
    if (llm.intent === "new_intake") {
      return { intent: "new_intake", preferredWindow: "", source: llm.source || "llm" };
    }
    if (llm.intent === "append_to_ticket") {
      return { intent: "append_to_ticket", preferredWindow: "", source: llm.source || "llm" };
    }
  }

  const det = classifyPostCompleteFollowUp({ bodyText, mediaItems });
  if (det === "ack_only") {
    return { intent: "ack_only", preferredWindow: "", source: "deterministic" };
  }
  if (det === "explicit_new_intake") {
    return { intent: "new_intake", preferredWindow: "", source: "deterministic" };
  }
  return { intent: "ask_same_or_new", preferredWindow: "", source: "deterministic" };
}

module.exports = {
  resolvePostCompleteFollowUpIntent,
};
