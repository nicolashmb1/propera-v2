/**
 * Gather-phase reply — LLM voice when safe; rules guard property and false handoff.
 */
const { promptForMissingField } = require("./deterministicPrompts");
const { buildGatherGreetingReply, isGatheringGreetingOnly } = require("./gatherGreetingReply");
const { isTenantConfusedMessage, buildConfusionResetReply } = require("./postHandoffReply");
const { getGatherSafety, llmReplyAsksForSchedule } = require("./detectGatherSafety");
const { buildSafetyGatherReply } = require("./gatherSafetyReply");

const FALSE_HANDOFF_RE =
  /\b(pass(ed)?\s+(this\s+)?along|noted\s+for\s+maintenance|logged|get\s+this\s+(issue\s+)?(noted|submitted|sent)|they('ll|\s+will)\s+be\s+in\s+touch|maintenance\s+will|i('ve|\s+have)\s+(noted|logged|submitted|everything\s+i\s+need))\b/i;

/**
 * @param {object} o
 * @param {string | null} [o.llmGatherReply]
 * @param {{ ready: boolean, missing: string | null }} o.complete
 * @param {object} [o.partial]
 * @param {object[]} [o.propertiesList]
 * @param {object[]} [o.recentMessages]
 * @param {string} [o.bodyText]
 * @returns {string}
 */
function resolveGatherReply(o) {
  const complete = o.complete || { ready: false, missing: "property" };
  const partial = o.partial || {};
  const propertiesList = o.propertiesList || [];
  const bodyText = String(o.bodyText || "").trim();
  const candidates = Array.isArray(partial._property_candidates)
    ? partial._property_candidates
    : [];

  if (complete.ready) {
    return String(o.llmGatherReply || "").trim() || "Thanks — one moment while I log that.";
  }

  if (candidates.length > 1) {
    return promptForMissingField("property", partial, propertiesList);
  }

  const missing = String(complete.missing || "").toLowerCase();
  const safetyReply = buildSafetyGatherReply(missing, partial, propertiesList);
  const missingPrompt =
    safetyReply || promptForMissingField(missing, partial, propertiesList);

  if (missing === "property" && !String(partial.property || "").trim() && bodyText) {
    if (isGatheringGreetingOnly(bodyText, partial)) {
      return buildGatherGreetingReply({ propertiesList, partial });
    }
    if (isTenantConfusedMessage(bodyText)) {
      return buildConfusionResetReply();
    }
  }

  const llm = String(o.llmGatherReply || "").trim();
  const safety = getGatherSafety(partial);

  if (!llm) return missingPrompt;
  if (FALSE_HANDOFF_RE.test(llm)) return missingPrompt;
  if (safety && llmReplyAsksForSchedule(llm)) return missingPrompt;

  // Property must be grounded — never let LLM skip or guess building.
  if (missing === "property") return missingPrompt;
  if (safety) return missingPrompt;

  // Avoid repeating the exact same assistant question three times.
  const recentAssistant = (o.recentMessages || [])
    .filter((m) => m && m.role === "assistant")
    .slice(-2)
    .map((m) => String(m.content || m.text || "").trim())
    .filter(Boolean);
  if (
    recentAssistant.length >= 2 &&
    recentAssistant[0] === recentAssistant[1] &&
    recentAssistant[1] === missingPrompt
  ) {
    return llm !== missingPrompt ? llm : `${missingPrompt} (If you're all set, just say thanks.)`;
  }

  return llm;
}

module.exports = {
  resolveGatherReply,
  FALSE_HANDOFF_RE,
};
