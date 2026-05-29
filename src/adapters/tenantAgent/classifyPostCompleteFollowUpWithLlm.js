/**
 * Post-handoff follow-up intent — interpretation only (open ticket context + thread).
 */
const { openaiApiKey, tenantAgentLlmEnabled, tenantAgentLlmModel } = require("../../config/env");
const { openaiChatJson } = require("../../brain/intake/openaiStructuredSignal");
const { extractBrainReceiptFacts } = require("./extractBrainReceiptFacts");

const TIMEOUT_MS = 12000;

let _testPostCompleteFollowUpLlm = null;

function setPostCompleteFollowUpLlmForTests(fn) {
  _testPostCompleteFollowUpLlm = typeof fn === "function" ? fn : null;
}

function clearPostCompleteFollowUpLlmForTests() {
  _testPostCompleteFollowUpLlm = null;
}

/**
 * @param {unknown} json
 * @returns {{
 *   intent: 'schedule_update' | 'ack_only' | 'append_to_ticket' | 'new_intake' | 'unclear',
 *   preferredWindow: string,
 * }}
 */
function normalizePostCompleteFollowUpLlmResult(json) {
  if (!json || typeof json !== "object") {
    return { intent: "unclear", preferredWindow: "" };
  }
  const raw = String(json.follow_up_intent || json.intent || "").trim().toLowerCase();
  let intent = "unclear";
  if (
    raw === "schedule_update" ||
    raw === "schedule_change" ||
    raw === "preferred_window" ||
    raw === "reschedule"
  ) {
    intent = "schedule_update";
  } else if (raw === "ack_only" || raw === "thanks" || raw === "closing") {
    intent = "ack_only";
  } else if (raw === "append_to_ticket" || raw === "append" || raw === "same_ticket") {
    intent = "append_to_ticket";
  } else if (raw === "new_intake" || raw === "new_issue" || raw === "new") {
    intent = "new_intake";
  } else if (raw === "unclear" || raw === "unknown") {
    intent = "unclear";
  }

  const preferredWindow = String(
    json.preferred_window || json.preferredWindow || json.schedule_text || ""
  ).trim();

  return { intent, preferredWindow };
}

/**
 * @param {object} o
 * @param {string} o.bodyText
 * @param {string} [o.activeTicketKey]
 * @param {object} [o.lastBrainResult]
 * @param {object[]} [o.recentMessages]
 * @param {string} [o.traceId]
 * @returns {Promise<{ intent: string, preferredWindow: string, source: string }>}
 */
async function classifyPostCompleteFollowUpWithLlm(o) {
  if (_testPostCompleteFollowUpLlm) return _testPostCompleteFollowUpLlm(o);

  if (!tenantAgentLlmEnabled() || !openaiApiKey()) {
    return { intent: "unclear", preferredWindow: "", source: "llm_off" };
  }

  const bodyText = String(o.bodyText || "").trim();
  if (!bodyText) {
    return { intent: "unclear", preferredWindow: "", source: "empty" };
  }

  const last = o.lastBrainResult && typeof o.lastBrainResult === "object" ? o.lastBrainResult : {};
  const facts = extractBrainReceiptFacts(last);
  const ticketRef =
    facts && !facts.multi && facts.fins && facts.fins[0]
      ? String(facts.fins[0].ticketId || "").trim()
      : String(last.finalize?.ticketId || last.finalize?.ticket_id || "").trim();

  const system =
    "You classify a tenant message sent AFTER a maintenance ticket was just opened or confirmed.\n" +
    "Use the conversation thread — the tenant is often replying about that same ticket.\n" +
    "Return JSON ONLY:\n" +
    "{\n" +
    '  "follow_up_intent": "schedule_update" | "ack_only" | "append_to_ticket" | "new_intake" | "unclear",\n' +
    '  "preferred_window": "visit time text to store, or empty"\n' +
    "}\n\n" +
    "Rules:\n" +
    "- schedule_update: tenant wants a different visit time/window on the OPEN ticket (morning, 8-10am, tomorrow 9-10, change time, can they come earlier). " +
    "Put ONLY the schedule phrase in preferred_window (e.g. \"tomorrow morning 8-10am\"), not thanks or unit numbers.\n" +
    "- ack_only: thanks / all good / closing with NO new maintenance detail or schedule change.\n" +
    "- append_to_ticket: more detail about the SAME problem (photos, worse, still leaking) — not a schedule-only change.\n" +
    "- new_intake: clearly a DIFFERENT maintenance problem or explicit new issue.\n" +
    "- Clock ranges like 9-10am are TIMES, never unit numbers.\n" +
    "- Do not invent ticket ids or staff promises.";

  const userPayload = {
    inbound_message: bodyText,
    open_ticket_ref: ticketRef,
    active_ticket_key: String(o.activeTicketKey || "").trim(),
    recent_messages: Array.isArray(o.recentMessages) ? o.recentMessages.slice(-12) : [],
    trace_id: String(o.traceId || "").trim(),
  };

  const r = await openaiChatJson({
    apiKey: openaiApiKey(),
    model: tenantAgentLlmModel(),
    system,
    user: JSON.stringify(userPayload),
    timeoutMs: TIMEOUT_MS,
  });

  if (!r.ok || !r.json) {
    return { intent: "unclear", preferredWindow: "", source: "llm_fail" };
  }

  const norm = normalizePostCompleteFollowUpLlmResult(r.json);
  if (norm.intent === "unclear") {
    return { intent: "unclear", preferredWindow: "", source: "llm_unclear" };
  }

  return {
    intent: norm.intent,
    preferredWindow: norm.preferredWindow,
    source: "llm",
  };
}

module.exports = {
  classifyPostCompleteFollowUpWithLlm,
  normalizePostCompleteFollowUpLlmResult,
  setPostCompleteFollowUpLlmForTests,
  clearPostCompleteFollowUpLlmForTests,
};
