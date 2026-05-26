function normalizeBody(raw) {
  return String(raw || "").trim();
}

function classifyReply(raw) {
  const text = normalizeBody(raw);
  if (!text) return "UNKNOWN";

  const lower = text.toLowerCase();
  const normalized = lower.replace(/[^\p{L}\p{N}\s?!]/gu, " ").replace(/\s+/g, " ").trim();

  if (/^(stop|stopall|unsubscribe|cancel|end|quit)\b/i.test(normalized)) {
    return "OPT_OUT";
  }

  if (
    /\b(fire|smoke|gas leak|gas smell|carbon monoxide|flood|flooding|sparking|electrical fire|emergency)\b/i.test(
      normalized
    )
  ) {
    return "EMERGENCY_SIGNAL";
  }

  if (
    /\b(leak|leaking|clog|clogged|broken|not working|no heat|no ac|no a\/c|no power|water|plumbing|toilet|sink|fridge|refrigerator|appliance|ceiling|mold|maintenance|repair)\b/i.test(
      normalized
    )
  ) {
    return "MAINTENANCE_SIGNAL";
  }

  if (
    normalized.includes("?") ||
    /^(when|what|why|how|can|could|would|will|where|who)\b/i.test(normalized)
  ) {
    return "QUESTION";
  }

  if (
    /\b(thanks|thank you|ok|okay|got it|received|sounds good|understood|perfect)\b/i.test(
      normalized
    )
  ) {
    return "ACKNOWLEDGMENT";
  }

  if (
    /\b(unacceptable|angry|upset|ridiculous|terrible|awful|frustrated|complaint)\b/i.test(
      normalized
    )
  ) {
    return "COMPLAINT";
  }

  return "UNKNOWN";
}

module.exports = {
  classifyReply,
};
