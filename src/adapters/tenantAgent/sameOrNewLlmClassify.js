/**
 * LLM assist for same vs new clarification — interpretation only, not operational authority.
 */
const { openaiApiKey, tenantAgentLlmEnabled, tenantAgentLlmModel } = require("../../config/env");
const { openaiChatJson } = require("../../brain/intake/openaiStructuredSignal");
const { isSameOrNewConfirmationOnly } = require("./resolveAppendHandoffContent");

const TIMEOUT_MS = 12000;

let _testSameOrNewLlm = null;

function setSameOrNewLlmForTests(fn) {
  _testSameOrNewLlm = typeof fn === "function" ? fn : null;
}

function clearSameOrNewLlmForTests() {
  _testSameOrNewLlm = null;
}

/**
 * @param {unknown} json
 * @returns {{ choice: 'same' | 'new' | 'unclear' | null, appendNote: string }}
 */
function normalizeSameOrNewLlmResult(json) {
  if (!json || typeof json !== "object") {
    return { choice: null, appendNote: "" };
  }
  const c = String(json.choice || json.intent || "").trim().toLowerCase();
  let choice = null;
  if (c === "same" || c === "existing" || c === "existing_request") choice = "same";
  else if (c === "new" || c === "new_issue" || c === "different") choice = "new";
  else if (c === "unclear" || c === "unknown") choice = "unclear";

  let appendNote = String(json.append_note || json.appendNote || "").trim();
  if (appendNote && isSameOrNewConfirmationOnly(appendNote)) {
    appendNote = "";
  }

  return { choice, appendNote };
}

/**
 * @param {object} o
 * @param {string} o.bodyText
 * @param {object} [o.pendingFollowUp]
 * @param {string} [o.traceId]
 * @param {object[]} [o.recentMessages]
 * @returns {Promise<{ choice: 'same' | 'new' | 'unclear' | null, appendNote: string, source: string }>}
 */
async function classifySameOrNewWithLlm(o) {
  if (_testSameOrNewLlm) return _testSameOrNewLlm(o);

  if (!tenantAgentLlmEnabled() || !openaiApiKey()) {
    return { choice: null, appendNote: "", source: "llm_off" };
  }

  const bodyText = String(o.bodyText || "").trim();
  if (!bodyText) {
    return { choice: null, appendNote: "", source: "empty" };
  }

  const pending = o.pendingFollowUp && typeof o.pendingFollowUp === "object" ? o.pendingFollowUp : {};
  const pendingBody = String(pending.bodyText || "").trim();
  const pendingMedia = String(pending.mediaJson || "").trim();
  const hasPendingMedia = pendingMedia.length > 2 && pendingMedia !== "[]";

  const system =
    "You classify a tenant reply after we asked: existing maintenance request or new issue?\n" +
    "Return JSON ONLY:\n" +
    "{\n" +
    '  "choice": "same" | "new" | "unclear",\n' +
    '  "append_note": "substantive update text for the ticket note, or empty string"\n' +
    "}\n\n" +
    "Rules:\n" +
    "- choice=same when tenant confirms existing request (e.g. yes, yep same, same one, same issue).\n" +
    "- choice=new when tenant says different/new/separate issue.\n" +
    "- append_note: the ACTUAL maintenance detail to store — from pending_follow_up.bodyText when confirming same, " +
    "plus any NEW symptom detail in inbound_message beyond confirmation words.\n" +
    "- append_note MUST NOT be confirmation phrases alone (never \"yep same\", \"same one\", \"yes same issue\").\n" +
    "- If pending is photo-only and tenant confirms same, append_note empty.\n" +
    "- Do not invent ticket ids, staff, or urgency.";

  const userPayload = {
    inbound_message: bodyText,
    pending_follow_up: {
      bodyText: pendingBody,
      has_media: hasPendingMedia,
    },
    recent_messages: Array.isArray(o.recentMessages) ? o.recentMessages.slice(-6) : [],
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
    return { choice: null, appendNote: "", source: "llm_fail" };
  }

  const norm = normalizeSameOrNewLlmResult(r.json);
  if (!norm.choice || norm.choice === "unclear") {
    return { choice: "unclear", appendNote: "", source: "llm_unclear" };
  }

  return { choice: norm.choice, appendNote: norm.appendNote, source: "llm" };
}

module.exports = {
  classifySameOrNewWithLlm,
  normalizeSameOrNewLlmResult,
  setSameOrNewLlmForTests,
  clearSameOrNewLlmForTests,
};
