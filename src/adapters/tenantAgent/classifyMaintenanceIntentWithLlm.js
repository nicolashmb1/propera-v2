/**
 * LLM maintenance vs non-maintenance intent — interpretation only; adapter decides deflect.
 */
const { openaiApiKey, tenantAgentLlmEnabled, tenantAgentLlmModel } = require("../../config/env");
const { openaiChatJson } = require("../../brain/intake/openaiStructuredSignal");

const TIMEOUT_MS = 12000;

let _testMaintenanceIntentLlm = null;

function setMaintenanceIntentLlmForTests(fn) {
  _testMaintenanceIntentLlm = typeof fn === "function" ? fn : null;
}

function clearMaintenanceIntentLlmForTests() {
  _testMaintenanceIntentLlm = null;
}

/**
 * @param {unknown} json
 * @returns {{ intent: 'maintenance_repair' | 'non_maintenance' | 'unclear', reason: string }}
 */
function normalizeMaintenanceIntentLlmResult(json) {
  if (!json || typeof json !== "object") {
    return { intent: "unclear", reason: "" };
  }
  const raw = String(json.intent || json.request_intent || "").trim().toLowerCase();
  let intent = "unclear";
  if (
    raw === "maintenance_repair" ||
    raw === "maintenance" ||
    raw === 'repair' ||
    raw === "maintenance_intake"
  ) {
    intent = "maintenance_repair";
  } else if (
    raw === "non_maintenance" ||
    raw === "non-maintenance" ||
    raw === "not_maintenance" ||
    raw === "off_topic" ||
    raw === "building_question" ||
    raw === "billing" ||
    raw === "amenity"
  ) {
    intent = "non_maintenance";
  } else if (raw === "unclear" || raw === "unknown") {
    intent = "unclear";
  }

  const reason = String(json.reason || json.rationale || "").trim();
  return { intent, reason };
}

/**
 * @param {object} o
 * @param {string} o.bodyText
 * @param {object} [o.partialPackage]
 * @param {object[]} [o.recentMessages]
 * @param {string} [o.traceId]
 * @returns {Promise<{ intent: 'maintenance_repair' | 'non_maintenance' | 'unclear', reason: string, source: string }>}
 */
async function classifyMaintenanceIntentWithLlm(o) {
  if (_testMaintenanceIntentLlm) return _testMaintenanceIntentLlm(o);

  if (!tenantAgentLlmEnabled() || !openaiApiKey()) {
    return { intent: "unclear", reason: "", source: "llm_off" };
  }

  const bodyText = String(o.bodyText || "").trim();
  if (!bodyText) {
    return { intent: "unclear", reason: "", source: "empty" };
  }

  const partial = o.partialPackage && typeof o.partialPackage === "object" ? o.partialPackage : {};
  const issue = String(partial.issue || "").trim();

  const system =
    "You classify a tenant SMS/WhatsApp/Telegram message for maintenance intake routing.\n" +
    "Return JSON ONLY:\n" +
    "{\n" +
    '  "intent": "maintenance_repair" | "non_maintenance" | "unclear",\n' +
    '  "reason": "short internal reason"\n' +
    "}\n\n" +
    "maintenance_repair — tenant reports something broken or needs fixing NOW:\n" +
    "leaks, no heat/AC, broken appliance/fixture, lockout, pests in unit, mold, smell gas, " +
    "clog, flooding, damage, bad odor/smell in unit or common area, dirty elevator/lobby/hallway " +
    "needing service, elevator not working, 'send someone to clean/fix' a building area.\n\n" +
    "non_maintenance — NOT a repair request:\n" +
    "billing, invoices, rent, lease copies, amenity booking or hours (gym, pool, laundry), " +
    "janitorial SCHEDULE questions only ('when is the cleaning guy coming', 'what day do they clean'), " +
    "trash/recycling pickup schedule, parking, packages, office hours, speak to manager, general building info.\n\n" +
    "If tenant asks to send someone to fix/clean a smelly or dirty area → maintenance_repair, not non_maintenance.\n\n" +
    "unclear — greeting only or too vague to tell.\n\n" +
    "Do not invent property, unit, or ticket ids.";

  const userPayload = {
    inbound_message: bodyText,
    partial_issue: issue,
    recent_messages: Array.isArray(o.recentMessages) ? o.recentMessages.slice(-8) : [],
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
    return { intent: "unclear", reason: "", source: "llm_fail" };
  }

  const norm = normalizeMaintenanceIntentLlmResult(r.json);
  return { ...norm, source: "llm" };
}

module.exports = {
  classifyMaintenanceIntentWithLlm,
  normalizeMaintenanceIntentLlmResult,
  setMaintenanceIntentLlmForTests,
  clearMaintenanceIntentLlmForTests,
};
