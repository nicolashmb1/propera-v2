/**
 * MessageSpec = template-as-contract (Phase 1): deterministic fallback + metadata.
 * Not the final platform registry — a few canonical rows to anchor compliance copy.
 */

/**
 * @typedef {object} MessageSpec
 * @property {string} templateKey
 * @property {string} fallbackText — required deterministic body when agent is off
 * @property {string} [tone] — hint for future agent refinement
 * @property {string} [channelHint] — e.g. short | rich
 */

/** @type {MessageSpec} */
const COMPLIANCE_STOP = {
  templateKey: "COMPLIANCE_STOP",
  fallbackText:
    "You have been unsubscribed from maintenance SMS/notifications. Reply START to resubscribe.",
  tone: "neutral",
  channelHint: "short",
};

/** @type {MessageSpec} */
const COMPLIANCE_START = {
  templateKey: "COMPLIANCE_START",
  fallbackText: "You have been resubscribed. How can we help?",
  tone: "warm",
  channelHint: "short",
};

/** @type {MessageSpec} */
const COMPLIANCE_HELP = {
  templateKey: "COMPLIANCE_HELP",
  fallbackText:
    "Propera maintenance: describe the issue, building, and unit. Reply STOP to opt out, START to opt back in.",
  tone: "neutral",
  channelHint: "short",
};

const BY_BRAIN = {
  compliance_stop: COMPLIANCE_STOP,
  compliance_start: COMPLIANCE_START,
  compliance_help: COMPLIANCE_HELP,
};

/**
 * @param {string | null | undefined} brain — e.g. complianceRun.brain
 * @returns {MessageSpec | null}
 */
function messageSpecForComplianceBrain(brain) {
  const k = String(brain || "").trim();
  return BY_BRAIN[k] || null;
}

module.exports = {
  COMPLIANCE_STOP,
  COMPLIANCE_START,
  COMPLIANCE_HELP,
  messageSpecForComplianceBrain,
};
