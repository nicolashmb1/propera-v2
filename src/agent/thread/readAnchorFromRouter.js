/**
 * Anchor hints from portal router parameter (not committed identity).
 */

const { readPortalPageContext } = require("../contextEnvelope");
const { mergeAnchorHints } = require("./anchorFingerprint");

function readPortalCostContext(routerParameter) {
  const p = routerParameter || {};
  let raw = p._portalCostContextJson;
  if (!raw) {
    try {
      const nest = JSON.parse(String(p._portalPayloadJson || "{}"));
      raw = nest.portal_cost_context ?? nest.portalCostContext;
      if (raw && typeof raw === "object") return raw;
    } catch (_) {
      return null;
    }
    return null;
  }
  try {
    const j = typeof raw === "string" ? JSON.parse(raw) : raw;
    return j && typeof j === "object" ? j : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {Record<string, string | undefined>} routerParameter
 */
function readAnchorFromRouter(routerParameter) {
  const page = readPortalPageContext(routerParameter);
  const cost = readPortalCostContext(routerParameter);
  return mergeAnchorHints(page, cost);
}

module.exports = { readAnchorFromRouter, readPortalCostContext };
