/**
 * GAS `properaExtractStructuredSignalLLM_` + `openaiChatJson_` — one chat completion, JSON object.
 * @see 07_PROPERA_INTAKE_PACKAGE.gs ~1174–1277
 */

const {
  properaRawStructuredSignalIsValid,
} = require("./structuredSignal");
const { openaiChatCompletionsWithRetry } = require("../../integrations/openaiTransport");

const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_INPUT = 3500;
const TIMEOUT_MS = 22000;

/**
 * @param {object} opts
 * @param {string} opts.text
 * @param {string} opts.phone
 * @param {string} opts.apiKey
 * @param {string} [opts.lang]
 * @param {object|null} [opts.context]
 * @param {string} [opts.model]
 * @returns {Promise<{ ok: boolean, signal: object|null, err: string }>}
 */
async function properaExtractStructuredSignalLLM(opts) {
  const phone = String(opts.phone || "").trim();
  const apiKey = String(opts.apiKey || "").trim();
  let input = String(opts.text || "").trim();
  if (!apiKey || !input) return { ok: false, signal: null, err: "missing_key_or_text" };
  if (input.length > MAX_INPUT) input = input.slice(0, MAX_INPUT);

  const model = String(opts.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;

  const system = buildSystemPrompt();
  let ctxStr = "";
  if (opts.context && typeof opts.context === "object") {
    try {
      ctxStr = "\ncontext=" + JSON.stringify(opts.context);
      if (ctxStr.length > 1800) ctxStr = ctxStr.slice(0, 1800);
    } catch (_) {
      ctxStr = "";
    }
  }
  const user =
    "lang_hint=" +
    JSON.stringify(String(opts.lang || "en")) +
    "\nmessage=" +
    JSON.stringify(input) +
    ctxStr;

  const r = await openaiChatJson({
    apiKey,
    model,
    system,
    user,
    timeoutMs: TIMEOUT_MS,
  });

  if (!r.ok || !r.json) return { ok: false, signal: null, err: r.err || "api_fail" };
  if (!properaRawStructuredSignalIsValid(r.json))
    return { ok: false, signal: null, err: "invalid_shape" };
  return { ok: true, signal: r.json, err: "" };
}

function buildSystemPrompt() {
  return (
    "You are the ONLY interpreter of this inbound message for a property operations system.\n" +
    "Return JSON ONLY. No markdown, no commentary.\n\n" +
    "Schema (all keys required; use \"\" or [] or null or {} where unknown):\n" +
    "- actorType: TENANT | STAFF | UNKNOWN\n" +
    "- operationMode: WRITE | READ\n" +
    "- intentType: short label for the maintenance/request intent\n" +
    "- propertyCode: known building code ONLY if directly stated in the current message text, else \"\"\n" +
    "- propertyName: building name ONLY if directly stated, else \"\"\n" +
    "- unit: apartment/unit if stated, else \"\"\n" +
    "- issues: array of { title, summary, tenantDescription, locationArea, locationDetail, locationType, category, urgency }\n" +
    "  HOW MANY issues[] entries (most important):\n" +
    "  - Default: exactly ONE issue object that covers the whole request (best summary in summary/title).\n" +
    "  - Use TWO OR MORE objects ONLY when the message clearly describes SEPARATE failures that ops would normally treat as SEPARATE work orders (different equipment or different trade), e.g. \"sink is clogged\" AND \"ice maker not working\" (plumbing vs appliance).\n" +
    "  - Use ONE object when several phrases are really ONE root cause or one appliance/system, even if they sound like two complaints:\n" +
    "    • \"Refrigerator not working\" and \"doesn't make any ice\" → ONE issue (same fridge / cooling).\n" +
    "    • \"Sink clogged\" and \"water is draining slow\" / \"drains slowly\" → ONE issue (same drain / same plumbing symptom chain).\n" +
    "  - Do NOT split just because the tenant used \"and\", a comma, or two sentences; only split when a reasonable maintainer would open two unrelated tickets.\n" +
    "  - When in doubt, prefer ONE issue with a fuller summary.\n" +
    "- schedule: { \"raw\": string } or null\n" +
    "- actionSignals: object\n" +
    "- queryType: string\n" +
    "- targetHints: object\n" +
    "- turnType: OPERATIONAL_ONLY | CONVERSATIONAL_ONLY | MIXED | STATUS_QUERY | UNKNOWN\n" +
    "- conversationMove: THANKS | ACK | GREETING | GOODBYE | QUESTION | APOLOGY | FRUSTRATION | NONE\n" +
    "- statusQueryType: NONE | SCHEDULE | ETA | OWNER | GENERAL_STATUS\n" +
    "- conversationalReply: string\n" +
    "- confidence: number 0..1\n" +
    "- ambiguity: { \"flags\": string[], \"notes\": string }\n" +
    "- domainHint: MAINTENANCE | AMENITY | LEASING | CLEANING | CONFLICT | GENERAL | UNKNOWN\n" +
    "- safety: { \"isEmergency\": bool, \"emergencyType\": string, \"skipScheduling\": bool, \"requiresImmediateInstructions\": bool }\n\n" +
    "Rules: English for summary/title. Slot grounding is strict: only fill property/unit from text explicitly present. " +
    "If property not named in the message, propertyCode=\"\". Prefer empty over guessing."
  );
}

/**
 * @param {object} o
 * @param {string} o.apiKey
 * @param {string} o.model
 * @param {string} o.system
 * @param {string} o.user
 * @param {number} o.timeoutMs
 * @returns {Promise<{ ok: boolean, json: object|null, err: string }>}
 */
async function openaiChatJson(o) {
  const r = await openaiChatCompletionsWithRetry({
    apiKey: o.apiKey,
    timeoutMs: o.timeoutMs || TIMEOUT_MS,
    maxRetries: 2,
    body: {
      model: o.model,
      messages: [
        { role: "system", content: o.system },
        { role: "user", content: o.user },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    },
  });

  if (!r.ok || !r.data) {
    return { ok: false, json: null, err: r.err || "api_fail" };
  }
  try {
    const content =
      r.data.choices &&
      r.data.choices[0] &&
      r.data.choices[0].message &&
      r.data.choices[0].message.content;
    if (!content) return { ok: false, json: null, err: "no_content" };
    const json = JSON.parse(String(content));
    return { ok: true, json, err: "" };
  } catch (e) {
    return {
      ok: false,
      json: null,
      err: String(e && e.message ? e.message : e),
    };
  }
}

module.exports = {
  properaExtractStructuredSignalLLM,
  openaiChatJson,
};
