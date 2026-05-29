/**
 * Sticky lane router — one decision per session, not per turn.
 *
 * Architecture:
 *   - Lane is decided once when a conversation starts.
 *   - While a lane is active, every inbound message goes to that lane.
 *   - The lane owns interpretation (corrections, follow-ups, clarifications).
 *   - The router does NOT re-detect keywords on each turn.
 *
 * Lane closes when:
 *   - Tenant explicitly says "thanks / all done / never mind"
 *   - The lane's brain signals completion (e.g. ticket created, booking done + closing)
 *   - 48h TTL expires (handled by conversationExpiry)
 */
const { appendMessage, saveTenantConversation } = require("./conversationStore");
const {
  CONVERSATION_LANE,
  resolveActiveLane,
  isStrongMaintenanceInterrupt,
  isLaneCloseSignal,
  shouldCloseAccessLaneAfterBooking,
} = require("./conversationLane");
const { clearAccessLane, readAccessLastBooking } = require("./conversationState");
const { tenantAgentLlmEnabled, openaiApiKey } = require("../../config/env");
const { appendEventLog } = require("../../dal/appendEventLog");

function llmIsActive() {
  return tenantAgentLlmEnabled() && !!openaiApiKey();
}

/**
 * @param {object} o
 * @param {object | null} o.conv
 * @param {string} o.bodyText
 * @param {Record<string, string>} o.routerParameter
 * @param {string} o.tenantActorKey
 * @param {string} o.traceId
 * @param {'sms'|'whatsapp'|'telegram'} o.transportChannel
 * @returns {Promise<object | null>}  null = no active lane (caller decides)
 */
async function dispatchByActiveLane(o) {
  const conv = o.conv || null;
  const bodyText = String(o.bodyText || "").trim();
  if (!bodyText) return null;

  const lane = resolveActiveLane(conv);
  if (!lane) return null;

  if (lane === CONVERSATION_LANE.ACCESS) {
    // Always-on safety net: a strong maintenance signal in the body text wins
    // over the access lane regardless of LLM availability. Doctrine: "AI is
    // interpretation, not control" — the lane decision is control. The LLM
    // is ALSO allowed to emit `access_intent: "switch_maintenance"` inside
    // `maybeHandleAccessTurn`, but that path now serves only as acceleration
    // for nuanced phrasings the regex doesn't catch. Prod traffic showed the
    // LLM silently missing obvious cases (sink + slow drip = list_slots),
    // and the previous `if (!llmIsActive())` gate let those through.
    if (isStrongMaintenanceInterrupt(bodyText)) {
      await appendEventLog({
        traceId: String(o.traceId || "").trim(),
        log_kind: "tenant_agent",
        event: "TENANT_AGENT_ACCESS_LANE_DETERMINISTIC_INTERRUPT",
        payload: {
          conversation_id: conv?.id || null,
          tenant_actor_key: String(o.tenantActorKey || "").trim(),
          to: "maintenance",
          inbound_preview: bodyText.slice(0, 120),
          llm_active: llmIsActive(),
        },
      });
      await clearAccessLaneOnConv(o);
      return null;
    }

    // Always-on lane close: "thanks", "ok thanks brother", etc. Doctrine: lane
    // control is deterministic. Prod showed LLM re-handoffing the same window
    // after access_reserved → overlap with the tenant's own booking.
    if (isLaneCloseSignal(bodyText) || shouldCloseAccessLaneAfterBooking(conv, bodyText)) {
      await appendEventLog({
        traceId: String(o.traceId || "").trim(),
        log_kind: "tenant_agent",
        event: "TENANT_AGENT_ACCESS_LANE_DETERMINISTIC_CLOSE",
        payload: {
          conversation_id: conv?.id || null,
          tenant_actor_key: String(o.tenantActorKey || "").trim(),
          inbound_preview: bodyText.slice(0, 120),
          after_booking: shouldCloseAccessLaneAfterBooking(conv, bodyText),
          llm_active: llmIsActive(),
        },
      });
      return await closeAccessLaneTurn(o);
    }

    const { maybeHandleAccessTurn } = require("./maybeHandleAccessTurn");
    const turn = await maybeHandleAccessTurn({ ...o, lockedLane: true });
    if (turn) return turn;
    // maybeHandleAccessTurn returned null — either LLM-signalled lane switch
    // (lane is already cleared) or an unhandled edge case. Fall through to the
    // rest of the pipeline.
    return null;
  }

  // Maintenance lane: caller's existing maintenance gather continues to handle it.
  // (No re-detection needed — the rest of runTenantAgentTurn is the maintenance path.)
  return null;
}

async function closeAccessLaneTurn(o) {
  const conv = o.conv || null;
  const bodyText = String(o.bodyText || "").trim();
  const lastBooking = readAccessLastBooking(conv?.partial_package);
  const replyText = lastBooking
    ? "You're all set — talk soon."
    : "Got it. Let me know if you need anything else.";

  const turnCount = conv ? Number(conv.turn_count || 0) + 1 : 1;
  const messages = conv
    ? appendMessage(appendMessage(conv, "user", bodyText), "assistant", replyText)
    : appendMessage(
        appendMessage({ messages: [] }, "user", bodyText),
        "assistant",
        replyText
      );

  const partial = clearAccessLane(conv?.partial_package || {});

  const saved = await saveTenantConversation({
    ...(conv || {}),
    tenant_actor_key: o.tenantActorKey,
    transport_channel: o.transportChannel,
    status: "gathering",
    partial_package: partial,
    messages: { messages }.messages || messages,
    turn_count: turnCount,
    tenant_locale: conv?.tenant_locale || "en",
  });

  return {
    handled: true,
    phase: "gather",
    replyText,
    conversationId: saved?.id || conv?.id || "",
    tenantLocale: saved?.tenant_locale || conv?.tenant_locale || "en",
  };
}

/**
 * Clear access lane state in memory + DB so downstream handlers (maintenance
 * gather) process the inbound as a fresh message.
 */
async function clearAccessLaneOnConv(o) {
  const conv = o.conv || null;
  if (!conv) return;
  const partial = clearAccessLane(conv.partial_package);
  conv.partial_package = partial;

  await saveTenantConversation({
    ...conv,
    tenant_actor_key: o.tenantActorKey,
    transport_channel: o.transportChannel,
    status: "gathering",
    partial_package: partial,
    messages: conv.messages || [],
    turn_count: Number(conv.turn_count || 0),
    tenant_locale: conv.tenant_locale || "en",
  });
}

module.exports = {
  dispatchByActiveLane,
};
