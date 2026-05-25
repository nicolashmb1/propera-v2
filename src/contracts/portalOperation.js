/**
 * Structured portal / tenant-agent payloads — operation intent (not transport channel).
 */

/**
 * @param {Record<string, unknown>} [routerParameter]
 * @returns {string}
 */
function readPortalOperation(routerParameter) {
  const p = routerParameter || {};
  const action = String(p._portalAction || "").trim().toLowerCase();
  try {
    const j = JSON.parse(String(p._portalPayloadJson || "{}"));
    const op = String(j.operation || j.action || "").trim().toLowerCase();
    if (op) return op;
  } catch (_) {
    /* ignore */
  }
  return action;
}

/**
 * @param {Record<string, unknown>} [routerParameter]
 * @returns {boolean}
 */
function isAppendToTicketOperation(routerParameter) {
  return readPortalOperation(routerParameter) === "append_to_ticket";
}

/**
 * @param {Record<string, unknown>} [routerParameter]
 * @returns {boolean}
 */
function isFindRelatedTicketOperation(routerParameter) {
  return readPortalOperation(routerParameter) === "find_related_ticket";
}

module.exports = {
  readPortalOperation,
  isAppendToTicketOperation,
  isFindRelatedTicketOperation,
};
