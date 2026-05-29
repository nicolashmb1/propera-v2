/**
 * Access gather LLM turn — expression only; handoff confirmed by rules after merge.
 */
const { openaiApiKey, tenantAgentLlmModel } = require("../../config/env");
const { openaiChatJson } = require("../../brain/intake/openaiStructuredSignal");
const { buildAccessGatherSystemPrompt } = require("./accessSystemPrompt");
const {
  isValidAccessLlmTurnJson,
  normalizeAccessLlmTurn,
} = require("./mergeAccessPartialFromLlm");
const { propertyTimezone } = require("../../access/parseAccessIntent");
const { resolveToday } = require("../../access/dayResolver");

function buildTodayContext(now = new Date()) {
  const tz = propertyTimezone();
  const today = resolveToday(now, tz);
  return {
    today_iso: today.isoDate,
    today_weekday: today.weekday,
    timezone: tz,
  };
}

const TIMEOUT_MS = 22000;

let _testAccessAgentLlm = null;

function setAccessAgentLlmForTests(fn) {
  _testAccessAgentLlm = typeof fn === "function" ? fn : null;
}

function clearAccessAgentLlmForTests() {
  _testAccessAgentLlm = null;
}

/**
 * @param {object} opts
 * @param {string} opts.inboundMessage
 * @param {object} opts.accessRequest
 * @param {object[]} [opts.messages]
 * @param {object[]} [opts.amenities]
 * @param {object} [opts.lastAccessError]
 * @param {string} [opts.traceId]
 */
async function runAccessAgentLlmTurn(opts) {
  if (_testAccessAgentLlm) return _testAccessAgentLlm(opts);

  const apiKey = openaiApiKey();
  const inbound = String(opts.inboundMessage || "").trim();
  if (!apiKey || !inbound) {
    return { ok: false, err: "missing_key_or_text" };
  }

  const system = buildAccessGatherSystemPrompt(opts.amenities || []);
  const todayCtx = buildTodayContext(new Date());
  const userPayload = {
    today: todayCtx,
    access_request: opts.accessRequest || {},
    last_access_error: opts.lastAccessError || null,
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
  if (!isValidAccessLlmTurnJson(r.json)) {
    return { ok: false, err: "invalid_shape" };
  }

  const norm = normalizeAccessLlmTurn(r.json);
  return {
    ok: true,
    reply: norm.reply,
    accessIntent: norm.accessIntent,
    partialUpdates: norm.partialUpdates,
    handoffReady: norm.handoffReady,
    err: "",
  };
}

module.exports = {
  runAccessAgentLlmTurn,
  setAccessAgentLlmForTests,
  clearAccessAgentLlmForTests,
};
