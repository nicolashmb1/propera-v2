/**
 * COMPLIANCE INTENT (EXACT-ONLY)
 * Ported from GAS: complianceIntent_
 * @see ../../../15_GATEWAY_WEBHOOK.gs lines 1021–1077
 *
 * @returns {"" | "STOP" | "START" | "HELP"}
 */
function complianceIntent(rawAny) {
  const s0 = String(rawAny || "");
  if (!s0) return "";

  const s = s0
    .trim()
    .toUpperCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[.,!?:;'"`(){}\[\]<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!s) return "";

  const STOP_WORDS = {
    STOP: 1,
    STOPALL: 1,
    UNSUBSCRIBE: 1,
    CANCEL: 1,
    END: 1,
    QUIT: 1,
    OPTOUT: 1,
    "OPT OUT": 1,
    REVOKE: 1,
  };

  if (STOP_WORDS[s]) return "STOP";

  const START_WORDS = {
    START: 1,
    UNSTOP: 1,
  };

  if (START_WORDS[s]) return "START";

  const HELP_WORDS = {
    HELP: 1,
    INFO: 1,
  };

  if (HELP_WORDS[s]) return "HELP";

  return "";
}

module.exports = { complianceIntent };
