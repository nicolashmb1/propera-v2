/**
 * Tenant Agent LLM gather turn — expression only; completeness confirmed by rules after merge.
 */
const { openaiApiKey, openaiModelExtract, tenantAgentLlmModel } = require("../../config/env");
const { openaiChatJson } = require("../../brain/intake/openaiStructuredSignal");
const { buildTenantAgentGatherSystemPrompt } = require("./systemPrompt");
const {
  isValidTenantAgentLlmTurnJson,
  normalizeTenantAgentLlmTurn,
} = require("./mergePartialFromLlm");

const TIMEOUT_MS = 22000;

let _testTenantAgentLlm = null;

function setTenantAgentLlmForTests(fn) {
  _testTenantAgentLlm = typeof fn === "function" ? fn : null;
}

function clearTenantAgentLlmForTests() {
  _testTenantAgentLlm = null;
}

/**
 * @param {object} opts
 * @param {string} opts.inboundMessage
 * @param {object} opts.partialPackage
 * @param {object[]} [opts.messages]
 * @param {object[]} [opts.propertiesList]
 * @param {string} [opts.traceId]
 * @returns {Promise<{ ok: boolean, reply?: string, partialUpdates?: object, handoffReady?: boolean, tenantLocale?: string, requestIntent?: string, conversationSignal?: string, err?: string }>}
 */
async function runTenantAgentLlmTurn(opts) {
  if (_testTenantAgentLlm) return _testTenantAgentLlm(opts);

  const apiKey = openaiApiKey();
  const inbound = String(opts.inboundMessage || "").trim();
  if (!apiKey || !inbound) {
    return { ok: false, err: "missing_key_or_text" };
  }

  const system = buildTenantAgentGatherSystemPrompt(opts.propertiesList || []);
  const userPayload = {
    partial_package: opts.partialPackage || {},
    recent_messages: Array.isArray(opts.messages) ? opts.messages.slice(-12) : [],
    inbound_message: inbound,
    trace_id: String(opts.traceId || "").trim(),
  };

  const r = await openaiChatJson({
    apiKey,
    model: tenantAgentLlmModel(),
    system,
    user: JSON.stringify(userPayload),
    timeoutMs: TIMEOUT_MS,
  });

  if (!r.ok || !r.json) {
    return { ok: false, err: r.err || "api_fail" };
  }
  if (!isValidTenantAgentLlmTurnJson(r.json)) {
    return { ok: false, err: "invalid_shape" };
  }

  const norm = normalizeTenantAgentLlmTurn(r.json);
  return {
    ok: true,
    reply: norm.reply,
    partialUpdates: norm.partialUpdates,
    handoffReady: norm.handoffReady,
    tenantLocale: norm.tenantLocale,
    requestIntent: norm.requestIntent,
    conversationSignal: norm.conversationSignal,
    safetyAssessment: norm.safetyAssessment,
    err: "",
  };
}

module.exports = {
  runTenantAgentLlmTurn,
  setTenantAgentLlmForTests,
  clearTenantAgentLlmForTests,
};
