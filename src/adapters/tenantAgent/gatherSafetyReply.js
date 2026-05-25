/**
 * Safety-aware gather prompts — override casual LLM tone for gas/fire/flood.
 */
const {
  promptForMissingField,
  buildPropertyAsk,
  buildPropertyDisambiguationPrompt,
} = require("./deterministicPrompts");
const { getGatherSafety } = require("./detectGatherSafety");

/**
 * @param {{ emergencyType?: string }} safety
 * @returns {string}
 */
function safetyLeadLine(safety) {
  const em = String((safety && safety.emergencyType) || "").toUpperCase();
  if (em === "GAS" || /\bGAS\b/.test(em)) {
    return (
      "This could be a gas issue — please don't use the stove or oven. " +
      "If the smell continues or gets stronger, leave your apartment and call 911."
    );
  }
  if (em === "CO" || /\bCO\b/.test(em) || /CARBON MONOXIDE/.test(em)) {
    return (
      "This may be carbon monoxide — get fresh air right away and call 911 if you feel dizzy, sick, or faint."
    );
  }
  if (em === "FIRE" || em === "SMOKE") {
    return (
      "If you see fire or heavy smoke, leave the building and call 911 now. " +
      "We're treating this as urgent."
    );
  }
  if (em === "FLOOD") {
    return "We're treating this as urgent — if water is still coming in, stay clear of wet areas and avoid electrical outlets nearby.";
  }
  if (em === "SEWAGE") {
    return "We're treating this as urgent — stay out of affected areas and avoid using water in that part of the unit if you can.";
  }
  if (em === "ELECTRICAL") {
    return "We're treating this as urgent — stay away from the outlet or panel, don't touch it, and avoid using that circuit.";
  }
  if (em === "NO_HEAT") {
    return "We're treating this as urgent — we'll follow up quickly. If it is unsafe to stay, go somewhere warm.";
  }
  if (em === "NO_AC") {
    return (
      "We're treating this as urgent — extreme heat without AC is a priority, especially with an infant. " +
      "Someone will follow up immediately."
    );
  }
  if (em === "INJURY") {
    return "If someone is seriously hurt, call 911 first. We're treating this as urgent.";
  }
  return "We're treating this as urgent and will prioritize follow-up.";
}

/**
 * @param {string | null} missing
 * @param {object} partial
 * @param {object[]} propertiesList
 * @returns {string | null}
 */
function buildSafetyGatherReply(missing, partial, propertiesList) {
  const safety = getGatherSafety(partial);
  if (!safety) return null;

  const ackSent = !!partial._safety_ack_sent;
  const lead = ackSent ? "" : safetyLeadLine(safety);
  const m = String(missing || "").toLowerCase();
  const candidates = Array.isArray(partial._property_candidates)
    ? partial._property_candidates
    : [];

  const withLead = (ask) => (ackSent ? ask : `${lead}\n\n${ask}`);

  if (m === "property") {
    const ask =
      candidates.length > 1
        ? buildPropertyDisambiguationPrompt(candidates)
        : buildPropertyAsk(propertiesList);
    return withLead(ask);
  }
  if (m === "unit") {
    const ask = ackSent
      ? "And your unit number?"
      : "What's your unit number? We'll get someone on this right away — no visit time needed.";
    return withLead(ask);
  }
  if (m === "issue") {
    return withLead("Can you briefly describe what's going on?");
  }
  return ackSent ? "" : lead;
}

module.exports = {
  buildSafetyGatherReply,
  safetyLeadLine,
};
