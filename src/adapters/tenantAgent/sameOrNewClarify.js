/**
 * Same request vs new issue — tenant confirmation before append or new intake.
 * Natural language only in prompts; replies parsed by rules (+ optional LLM when enabled).
 */
const { extractBrainReceiptFacts } = require("./extractBrainReceiptFacts");
const { classifySameOrNewWithLlm } = require("./sameOrNewLlmClassify");
const { tenantAgentLlmEnabled, openaiApiKey } = require("../../config/env");

const SAME_OR_NEW_PROMPT_BASE =
  "Quick check — is this about the maintenance request you just opened, or a different issue?";

const SAME_OR_NEW_REASK =
  "I want to route this correctly — is this about your existing maintenance request, or something new?";

/**
 * @param {object} [conv]
 * @returns {string}
 */
function buildSameOrNewPrompt(conv) {
  const last = conv && conv.last_brain_result ? conv.last_brain_result : {};
  const facts = extractBrainReceiptFacts(last);
  const ref =
    facts && !facts.multi && facts.fins && facts.fins[0]
      ? String(facts.fins[0].ticketId || "").trim()
      : String(last.finalize?.ticketId || last.finalize?.ticket_id || "").trim();
  if (ref) {
    return (
      `Quick check — is this about your request (Ref #${ref}), or a different issue?`
    );
  }
  return SAME_OR_NEW_PROMPT_BASE;
}

/**
 * @returns {string}
 */
function buildSameOrNewReaskPrompt() {
  return SAME_OR_NEW_REASK;
}

/**
 * Deterministic natural-language parse for same vs new confirmation.
 * @param {string} text
 * @returns {'same' | 'new' | null}
 */
function parseSameOrNewReply(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const compact = raw.toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
  if (!compact) return null;

  if (/\b(not a new|not new|isn'?t (a )?new|no new issue|same (one|issue|request|ticket|problem|thing))\b/.test(compact)) {
    return "same";
  }
  if (/\b(new issue|new request|new ticket|new problem|different issue|different problem|something else|another issue|separate issue|not the same|unrelated)\b/.test(compact)) {
    return "new";
  }
  if (/\b(yes.*\bsame\b|same request|same ticket|existing request|that ticket|the one i (just )?(opened|reported|sent)|add (this |it )?to (that|my|the)|update (that|my|the))\b/.test(compact)) {
    return "same";
  }
  if (/\b(new one|different one|another one|brand new)\b/.test(compact)) {
    return "new";
  }

  if (/^(yes|yeah|yep|yup|yea|correct|right|sure|ok|okay|affirmative|same|existing|that one|the same|this one|original)\b/.test(compact)) {
    return "same";
  }
  if (/^(no|nope|nah|new|different|separate|another)\b/.test(compact)) {
    return "new";
  }

  if (/\b(still|getting worse|more (info|details|photos|pictures)|here('s| is) (another |a )?(photo|pic|picture|video))\b/.test(compact)) {
    if (!/\b(new|different|also my|another issue|separate)\b/.test(compact)) {
      return "same";
    }
  }

  if (/^(1|one)\b/.test(compact)) return "same";
  if (/^(2|two)\b/.test(compact)) return "new";

  return null;
}

/**
 * LLM first when enabled (with pending context); rules fallback.
 * @param {object} o
 * @param {string} o.bodyText
 * @param {object} [o.pendingFollowUp]
 * @param {string} [o.traceId]
 * @param {object[]} [o.recentMessages]
 * @returns {Promise<{ choice: 'same' | 'new' | null, appendNote: string, source: string }>}
 */
async function resolveSameOrNewReply(o) {
  const bodyText = String(o.bodyText || "").trim();
  const pendingFollowUp =
    o.pendingFollowUp && typeof o.pendingFollowUp === "object" ? o.pendingFollowUp : {};

  if (tenantAgentLlmEnabled() && openaiApiKey()) {
    const llm = await classifySameOrNewWithLlm({
      bodyText,
      pendingFollowUp,
      traceId: o.traceId,
      recentMessages: o.recentMessages,
    });
    if (llm.choice === "same" || llm.choice === "new") {
      return {
        choice: llm.choice,
        appendNote: String(llm.appendNote || "").trim(),
        source: llm.source || "llm",
      };
    }
  }

  const heuristic = parseSameOrNewReply(bodyText);
  if (heuristic) {
    return { choice: heuristic, appendNote: "", source: "heuristic" };
  }

  return { choice: null, appendNote: "", source: "unclear" };
}

/**
 * @param {object} o
 * @param {string} o.bodyText
 * @param {string} o.mediaJson
 * @returns {object}
 */
function captureFollowUpPending(o) {
  return {
    bodyText: String(o.bodyText || "").trim(),
    mediaJson: String(o.mediaJson || ""),
    captured_at: new Date().toISOString(),
  };
}

module.exports = {
  buildSameOrNewPrompt,
  buildSameOrNewReaskPrompt,
  parseSameOrNewReply,
  resolveSameOrNewReply,
  captureFollowUpPending,
  SAME_OR_NEW_PROMPT_BASE,
  SAME_OR_NEW_REASK,
};
