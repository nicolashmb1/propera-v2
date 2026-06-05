/**
 * Optional LLM polish for Jarvis Ask — facts-only, read-only.
 */

const { openaiChatJson } = require("../../brain/intake/openaiStructuredSignal");
const {
  openaiApiKey,
  jarvisAskLlmModel,
  jarvisAskLlmTimeoutMs,
} = require("../../config/env");

/**
 * @param {object} opts
 * @param {string} opts.question
 * @param {object} opts.facts
 * @param {string} opts.deterministicReply
 */
async function maybeJarvisAskLlmReply(opts) {
  const apiKey = openaiApiKey();
  if (!apiKey) return { ok: false, reply: "", err: "no_api_key" };

  const question = String(opts.question || "").trim();
  const facts = opts.facts || {};
  const fallback = String(opts.deterministicReply || "").trim();

  let factsStr = "";
  try {
    factsStr = JSON.stringify(facts);
    if (factsStr.length > 6000) factsStr = factsStr.slice(0, 6000);
  } catch (_) {
    factsStr = "{}";
  }

  const system =
    "You are Propera Jarvis Ask for property staff. Answer ONLY using the facts JSON and deterministic draft. " +
    "Do not promise repairs, schedules, charges, or closures. Do not invent ticket ids or amounts. " +
    "If facts are insufficient, say what is missing. Keep the answer concise (under 12 lines). " +
    "This is read-only — never instruct the user that an action was taken. " +
    'Respond with JSON only: {"reply":"..."}.';

  const user =
    "facts=" +
    factsStr +
    "\n\ndeterministic_draft:\n" +
    fallback +
    "\n\nstaff_question:\n" +
    question;

  const r = await openaiChatJson({
    apiKey,
    model: jarvisAskLlmModel(),
    system,
    user,
    timeoutMs: jarvisAskLlmTimeoutMs(),
  });

  if (!r.ok || !r.json || typeof r.json.reply !== "string") {
    return { ok: false, reply: fallback, err: r.err || "bad_llm_shape" };
  }

  const reply = String(r.json.reply || "").trim();
  if (!reply) return { ok: false, reply: fallback, err: "empty_reply" };
  return { ok: true, reply };
}

module.exports = { maybeJarvisAskLlmReply };
