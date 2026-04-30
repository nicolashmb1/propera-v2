/**
 * Shared secret for portal read/write HTTP (propera-app merge + portal inbound).
 */
const { nodeEnv, portalApiToken } = require("../config/env");

/**
 * @param {import("express").Request} req
 * @returns {boolean}
 */
function verifyPortalRequest(req) {
  const expected = portalApiToken();
  if (!expected) {
    return nodeEnv === "development";
  }

  const q = req.query || {};
  const header =
    String(req.get("x-propera-portal-token") || "").trim() ||
    String(req.get("authorization") || "")
      .replace(/^Bearer\s+/i, "")
      .trim();
  const queryTok = String(q.token || "").trim();
  const got = header || queryTok;
  return got === expected;
}

module.exports = { verifyPortalRequest };
