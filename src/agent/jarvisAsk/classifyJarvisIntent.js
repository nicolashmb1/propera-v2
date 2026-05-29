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
    /ticket|unit|apt|#|about|status|issue|assign|who|tenant|resident|timeline|history|last update|going on/.test(
      q
    ) ||
    /\b\d{2,4}[a-z]?\b/.test(q) ||
    /\b[a-z]{2,12}-\d{6}-\d{4}\b/i.test(q)
  ) {
    intents.add("TICKET_DETAIL");
  }

  if (!intents.size) intents.add("PROPERTY_SITUATION");
  return intents;
}

module.exports = { classifyJarvisIntent };
