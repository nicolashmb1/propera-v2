/**
 * Lightweight intent tags for Jarvis Ask formatting (read-only).
 */

/**
 * @param {string} question
 * @returns {Set<string>}
 */
function classifyJarvisIntent(question) {
  const q = String(question || "").trim().toLowerCase();
  const intents = new Set();
  if (!q) {
    intents.add("HELP");
    return intents;
  }

  if (
    /maintenance|property.*cost|cost.*property|how much.*spend|spend.*property|budget/.test(
      q
    ) &&
    !/this ticket|that ticket|unit \d/.test(q)
  ) {
    intents.add("PROPERTY_SPEND");
  }

  if (
    /cost|spend|charge|\$|receipt/.test(q) &&
    (/ticket|unit|this|that/.test(q) || !intents.has("PROPERTY_SPEND"))
  ) {
    intents.add("TICKET_COST");
  }

  if (
    /situation|brief|summary|how are we|what.?s going on|overview|status of (the )?property|catch me up|heads up/.test(
      q
    )
  ) {
    intents.add("PROPERTY_SITUATION");
  }

  if (/open|urgent|list|any ticket|how many ticket|waiting|backlog/.test(q)) {
    intents.add("OPEN_LIST");
  }

  if (
    /all (open )?(service|ticket|work)|every open|full list|whole portfolio|across (all |the )?propert|org.?wide|company.?wide|every service/.test(
      q
    )
  ) {
    intents.add("PORTFOLIO_OPEN_LIST");
    intents.add("OPEN_LIST");
  }

  if (
    /ticket|unit|apt|#|about|status|issue|assign|who|tenant|resident|timeline|history|last update|going on/.test(
      q
    ) ||
    /\b\d{2,4}[a-z]?\b/.test(q) ||
    /\b[a-z]{2,12}-\d{6}-\d{4}\b/i.test(q)
  ) {
    intents.add("TICKET_DETAIL");
  }

  if (
    /how many|how much|count|number of/.test(q) &&
    (/last\s+\d+\s+days?|past\s+\d+\s+days?|last\s+month|this\s+month/.test(q) ||
      /issue|ticket|service|problem|refrigerator|fridge|dishwasher|hvac|heat|leak|plumb|electrical/.test(
        q
      ))
  ) {
    intents.add("SERVICE_HISTORY");
  }

  if (
    /different units|distinct units|unique units|repeat.*unit|multiple.*unit|units with|unit breakdown|per unit/.test(
      q
    ) &&
    /issue|ticket|service|refrigerator|fridge|dishwasher|heat|last\s+\d+\s+days?/.test(q)
  ) {
    intents.add("SERVICE_HISTORY");
  }

  if (!intents.size) intents.add("PROPERTY_SITUATION");
  return intents;
}

/**
 * @param {string} question
 */
function isPortfolioOpenListQuestion(question) {
  const intents = classifyJarvisIntent(question);
  return intents.has("PORTFOLIO_OPEN_LIST");
}

module.exports = { classifyJarvisIntent, isPortfolioOpenListQuestion };
