/**
 * Vendor SMS reply grammar (YES/NO) — port of GAS `handleVendorAcceptDecline_` subset.
 * @see docs/VENDOR_LANE.md
 */

/**
 * @param {string} tok
 */
function looksLikeTicketId(tok) {
  const t = String(tok || "").trim();
  return t.length >= 6 && t.includes("-");
}

/**
 * @param {string} body
 * @returns {{
 *   kind: "empty" | "help" | "accept" | "decline";
 *   explicitTicketId?: string;
 *   tail?: string;
 * }}
 */
function parseVendorReply(body) {
  const text = String(body || "").trim();
  if (!text) return { kind: "empty" };

  const m = text.match(/^(yes|y|no|n)\b(?:\s+(.+))?$/i);
  if (!m) return { kind: "help" };

  const head = String(m[1] || "").toUpperCase();
  const rest = String(m[2] || "").trim();
  let explicitTicketId = "";
  let tail = rest;

  if (rest) {
    const first = rest.split(/\s+/)[0];
    if (looksLikeTicketId(first)) {
      explicitTicketId = first;
      tail = rest.substring(first.length).trim();
    }
  }

  const accept = head === "YES" || head === "Y";
  return {
    kind: accept ? "accept" : "decline",
    explicitTicketId,
    tail,
  };
}

module.exports = {
  looksLikeTicketId,
  parseVendorReply,
};
