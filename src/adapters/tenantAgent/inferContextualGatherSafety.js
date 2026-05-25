/**
 * Contextual gather safety — combination signals, not single-keyword triggers.
 * Backstop when LLM safety_assessment misses a situational emergency.
 */

/**
 * @param {string} combined
 * @returns {boolean}
 */
function hasVulnerablePerson(combined) {
  return /\b(baby|infant|newborn|toddler|child|children|kids|elderly|senior|disabled|medical condition|pregnant|pregnancy)\b/.test(
    combined
  );
}

/**
 * @param {string} combined
 * @returns {boolean}
 */
function hasExtremeHeatHazard(combined) {
  return (
    /\b(100\s*degrees?|extreme heat|heat wave|heatwave|90\+|95\+|triple digit)\b/.test(
      combined
    ) ||
    (/\b(ac|a\/c|air conditioning|cooling|hvac)\b/.test(combined) &&
      /\b(out|not working|broken|dead|won't work|wont work|stopped)\b/.test(combined))
  );
}

/**
 * @param {string} combined
 * @returns {boolean}
 */
function hasExtremeColdHazard(combined) {
  return (
    /\b(no heat|heat out|furnace|boiler|radiator)\b/.test(combined) &&
    /\b(out|not working|broken|no heat|freezing|dangerously cold|below freezing|frozen)\b/.test(
      combined
    )
  );
}

/**
 * @param {string} combined
 * @returns {boolean}
 */
function hasDangerDuration(combined) {
  return /\b(since yesterday|since last night|all day|all night|24\s*hours?|more than a day|days?\s+without|since morning|overnight)\b/.test(
    combined
  );
}

/**
 * @param {string} combined
 * @returns {boolean}
 */
function hasTenantDistress(combined) {
  return /\b(unbearable|cannot sleep|can't sleep|cant sleep|this is not ok|not ok|please someone|someone needs to come|asap|urgent|emergency|sweating|miserable|dangerous|health risk|unsafe)\b/.test(
    combined
  );
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isExplicitNonEmergencyCorrection(text) {
  return /\b(not an emergency|not urgent|not a fire|just needs|routine|only a battery|dead battery|not emergency)\b/i.test(
    String(text || "")
  );
}

/**
 * @param {string[]} texts — user messages this conversation + current inbound
 * @param {string} [latestText]
 * @returns {{ isEmergency: boolean, emergencyType: string, skipScheduling: boolean, requiresImmediateInstructions: boolean, receiptTier: 'emergency'|'urgent' } | null}
 */
function inferContextualGatherSafety(texts, latestText) {
  if (isExplicitNonEmergencyCorrection(latestText)) return null;

  const parts = (Array.isArray(texts) ? texts : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  const combined = parts.join(" ").toLowerCase();
  if (combined.length < 20) return null;

  const vulnerable = hasVulnerablePerson(combined);
  const extremeHeat = hasExtremeHeatHazard(combined);
  const extremeCold = hasExtremeColdHazard(combined);
  const duration = hasDangerDuration(combined);
  const distress = hasTenantDistress(combined);

  if (vulnerable && extremeHeat && (duration || distress)) {
    return {
      isEmergency: true,
      emergencyType: "NO_AC",
      skipScheduling: true,
      requiresImmediateInstructions: false,
      receiptTier: "emergency",
    };
  }

  if (vulnerable && extremeCold && (duration || distress)) {
    return {
      isEmergency: true,
      emergencyType: "NO_HEAT",
      skipScheduling: true,
      requiresImmediateInstructions: false,
      receiptTier: "emergency",
    };
  }

  if (extremeHeat && duration && distress) {
    return {
      isEmergency: true,
      emergencyType: "NO_AC",
      skipScheduling: true,
      requiresImmediateInstructions: false,
      receiptTier: "emergency",
    };
  }

  if (extremeCold && duration && distress) {
    return {
      isEmergency: true,
      emergencyType: "NO_HEAT",
      skipScheduling: true,
      requiresImmediateInstructions: false,
      receiptTier: "emergency",
    };
  }

  return null;
}

module.exports = {
  inferContextualGatherSafety,
  isExplicitNonEmergencyCorrection,
  hasVulnerablePerson,
  hasExtremeHeatHazard,
};
