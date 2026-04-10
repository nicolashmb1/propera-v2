/**
 * Ported from GAS: normMsg_
 * @see ../../../15_GATEWAY_WEBHOOK.gs (repo root) lines 1014–1016
 */
function normMsg(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = { normMsg };
