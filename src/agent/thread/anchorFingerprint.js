/**
 * Stable anchor fingerprint for Jarvis operator threads.
 */

const crypto = require("crypto");

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

/**
 * @param {object | null | undefined} anchor
 */
function buildAnchorFingerprint(anchor) {
  const a = anchor || {};
  const parts = [
    norm(a.propertyCode || a.property_code),
    norm(a.unit || a.unit_label),
    norm(a.ticketRowId || a.ticket_row_id),
    norm(a.humanTicketId || a.human_ticket_id),
  ];
  if (!parts.some(Boolean)) return "global";
  return crypto
    .createHash("sha256")
    .update(parts.join("|"))
    .digest("hex")
    .slice(0, 24);
}

/**
 * @param {string} actorKey
 * @param {string} transportChannel
 * @param {string} anchorFingerprint
 */
function buildThreadId(actorKey, transportChannel, anchorFingerprint) {
  const raw = [
    norm(actorKey),
    norm(transportChannel) || "portal",
    String(anchorFingerprint || "global").trim(),
  ].join("|");
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

/**
 * Merge page + cost context into anchor hints.
 * @param {object | null} pageContext
 * @param {object | null} costContext
 */
function mergeAnchorHints(pageContext, costContext) {
  const page = pageContext || {};
  const cost = costContext || {};
  return {
    propertyCode:
      String(page.propertyCode || cost.propertyCode || cost.property_code || "")
        .trim()
        .toUpperCase() || "",
    unit: String(page.unit || cost.unit || cost.unitLabel || cost.unit_label || "").trim(),
    ticketRowId: String(
      page.ticketRowId || cost.ticketRowId || cost.ticket_row_id || ""
    ).trim(),
    humanTicketId: String(
      page.humanTicketId || cost.humanTicketId || cost.human_ticket_id || ""
    )
      .trim()
      .toUpperCase(),
  };
}

module.exports = {
  buildAnchorFingerprint,
  buildThreadId,
  mergeAnchorHints,
};
