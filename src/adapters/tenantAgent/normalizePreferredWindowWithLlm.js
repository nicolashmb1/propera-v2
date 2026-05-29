/**
 * Normalize messy tenant visit-window text before deterministic parse + policy.
 */
const { openaiApiKey, tenantAgentLlmEnabled, tenantAgentLlmModel } = require("../../config/env");
const { openaiChatJson } = require("../../brain/intake/openaiStructuredSignal");

const TIMEOUT_MS = 12000;

let _testNormalizePreferredWindowLlm = null;

function setNormalizePreferredWindowLlmForTests(fn) {
  _testNormalizePreferredWindowLlm = typeof fn === "function" ? fn : null;
}

function clearNormalizePreferredWindowLlmForTests() {
  _testNormalizePreferredWindowLlm = null;
}

/**
 * @param {unknown} json
 * @returns {{ normalizedText: string, confidence: string }}
 */
function normalizePreferredWindowLlmResult(json) {
  if (!json || typeof json !== "object") {
    return { normalizedText: "", confidence: "low" };
  }
  const normalizedText = String(
    json.preferred_window || json.preferredWindow || json.normalized || ""
  ).trim();
  const confidence = String(json.confidence || "").trim().toLowerCase();
  return { normalizedText, confidence };
}

/**
 * @param {object} o
 * @param {string} o.rawText
 * @param {object[]} [o.recentMessages]
 * @param {string} [o.traceId]
 * @returns {Promise<{ ok: boolean, normalizedText: string, source: string }>}
 */
async function normalizePreferredWindowWithLlm(o) {
  if (_testNormalizePreferredWindowLlm) return _testNormalizePreferredWindowLlm(o);

  if (!tenantAgentLlmEnabled() || !openaiApiKey()) {
    return { ok: false, normalizedText: "", source: "llm_off" };
  }

  const rawText = String(o.rawText || "").trim();
  if (!rawText) {
    return { ok: false, normalizedText: "", source: "empty" };
  }

  const system =
    "You normalize tenant visit-window text for a maintenance scheduling parser.\n" +
    "Return JSON ONLY:\n" +
    "{\n" +
    '  "preferred_window": "short schedulable phrase",\n' +
    '  "confidence": "high" | "low"\n' +
    "}\n\n" +
    "Rules:\n" +
    "- If tenant REJECTS one time and states another, output ONLY the time they want.\n" +
    '- Example: "tomorrow before 3pm is no good, best time is 4pm" → "tomorrow 4pm"\n' +
    "- Keep day words (today, tomorrow, Friday) with the chosen time.\n" +
    "- Do not include rejected windows, thanks, or unit numbers.\n" +
    "- Do not invent dates beyond what the tenant implied.\n" +
    "- confidence=high when the intended window is clear.";

  const userPayload = {
    inbound_message: rawText,
    recent_messages: Array.isArray(o.recentMessages) ? o.recentMessages.slice(-10) : [],
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
    return { ok: false, normalizedText: "", source: "llm_fail" };
  }

  const norm = normalizePreferredWindowLlmResult(r.json);
  if (!norm.normalizedText || norm.confidence === "low") {
    return { ok: false, normalizedText: "", source: "llm_unclear" };
  }

  return { ok: true, normalizedText: norm.normalizedText, source: "llm" };
}

module.exports = {
  normalizePreferredWindowWithLlm,
  normalizePreferredWindowLlmResult,
  setNormalizePreferredWindowLlmForTests,
  clearNormalizePreferredWindowLlmForTests,
};
