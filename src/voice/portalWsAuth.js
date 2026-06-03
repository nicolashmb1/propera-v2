/**
 * Portal WebSocket auth — same secret as HTTP portal routes.
 */
const { nodeEnv, portalApiToken } = require("../config/env");

/**
 * @param {import("http").IncomingMessage} request
 */
function verifyPortalWebSocketRequest(request) {
  const expected = portalApiToken();
  if (!expected) {
    return nodeEnv === "development";
  }

  const url = new URL(request.url || "/", "http://localhost");
  const header =
    String(request.headers["x-propera-portal-token"] || "").trim() ||
    String(request.headers["authorization"] || "")
      .replace(/^Bearer\s+/i, "")
      .trim();
  const queryTok = String(url.searchParams.get("token") || "").trim();
  const got = header || queryTok;
  return got === expected;
}

module.exports = { verifyPortalWebSocketRequest };
